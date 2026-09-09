const { app, BrowserWindow } = require("electron");
const deadline = setTimeout(() => app.exit(1), 15000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { autoplayPolicy: "no-user-gesture-required" },
  });
  await win.loadURL("data:text/html,<title>Silent capture verification</title>");
  try {
    const result = await win.webContents.executeJavaScript(`(async () => {
      const results = [];
      for (const options of [{sinkId: {type: "none"}}, {sampleRate: 16000, sinkId: {type: "none"}}]) {
        const ctx = new AudioContext(options);
        try {
          if (ctx.sinkId?.type !== "none") throw new Error("Physical output selected");
          await ctx.resume();
          const oscillator = ctx.createOscillator();
          const analyser = ctx.createAnalyser();
          oscillator.connect(analyser);
          analyser.connect(ctx.destination);
          oscillator.start();
          const start = ctx.currentTime;
          await new Promise(resolve => setTimeout(resolve, 400));
          const samples = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(samples);
          const peak = Math.max(...samples.map(Math.abs));
          if (ctx.currentTime <= start || peak < 0.1) throw new Error("Silent graph did not process audio");
          if (options.sampleRate && ctx.sampleRate !== options.sampleRate) throw new Error("Sample rate changed");
          results.push({sink: ctx.sinkId.type, sampleRate: ctx.sampleRate, progressedSeconds: ctx.currentTime - start, peak});
          oscillator.stop();
        } finally { await ctx.close(); }
      }
      return results;
    })()`);
    console.log(JSON.stringify({ electron: process.versions.electron, chromium: process.versions.chrome, result }));
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
