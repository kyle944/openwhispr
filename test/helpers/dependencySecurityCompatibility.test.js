const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createInlineMarkdownSpec, mergeAttributes } = require("@tiptap/core");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const AdmZip = require("adm-zip");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-dependency-security-"));
}

test("Tiptap preserves ordinary editor attributes and inline Markdown round-trips", () => {
  const attrs = mergeAttributes(
    { class: "rich-text-editor prose", style: "color: navy; padding: 4px", "data-note-id": "42" },
    { class: "prose selected", style: "padding: 8px; font-weight: 600", title: "Résumé" }
  );

  assert.deepEqual(attrs, {
    class: "rich-text-editor prose selected",
    style: "color: navy; padding: 8px; font-weight: 600",
    "data-note-id": "42",
    title: "Résumé",
  });

  const mention = createInlineMarkdownSpec({
    nodeName: "mention",
    selfClosing: true,
    allowedAttributes: ["id", "label"],
  });
  const source = '[mention id="person-42" label="Miyazaki"]';
  const token = mention.markdownTokenizer.tokenize(source, [], {});

  assert.deepEqual(token, {
    type: "mention",
    raw: source,
    content: "",
    attributes: { id: "person-42", label: "Miyazaki" },
  });
  assert.equal(
    mention.renderMarkdown({
      type: "mention",
      attrs: { id: "person-42", label: "Miyazaki", ignoredByAllowlist: "no" },
    }),
    source
  );
});

test("Tiptap mergeAttributes retains an own JSON __proto__ key without inherited attributes", () => {
  const untrusted = JSON.parse(
    '{"__proto__":{"src":"x-invalid://canary","onerror":"unexpected","data-inherited":"no"}}'
  );
  const attrs = mergeAttributes({ "data-editor": "note" }, untrusted);

  assert.equal(Object.getPrototypeOf(attrs), Object.prototype);
  assert.deepEqual(Object.keys(attrs).sort(), ["__proto__", "data-editor"]);
  assert.equal(Object.hasOwn(attrs, "src"), false);
  assert.equal(attrs.src, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "src"), false);
});

test("xmldom retains Unicode and escapes when parsing and serializing valid XML", () => {
  const parseErrors = [];
  const xml = '<note title="Café &amp; tea">Miyazaki — こんにちは &amp; &lt;safe&gt;</note>';
  const document = new DOMParser({
    errorHandler: { error: (message) => parseErrors.push(String(message)) },
  }).parseFromString(xml, "text/xml");

  assert.deepEqual(parseErrors, []);
  assert.equal(document.documentElement.getAttribute("title"), "Café & tea");
  assert.equal(document.documentElement.textContent, "Miyazaki — こんにちは & <safe>");
  assert.equal(new XMLSerializer().serializeToString(document), xml);
});

test("xmldom reports malformed end-tag residue without changing normal recovery output", () => {
  const parseErrors = [];
  const document = new DOMParser({
    errorHandler: { error: (message) => parseErrors.push(String(message)) },
  }).parseFromString("<a></a\njunk>", "text/xml");

  assert.ok(parseErrors.length > 0, "malformed end-tag residue must be reported");
  assert.equal(new XMLSerializer().serializeToString(document), "<a/>");
});

test("adm-zip extracts in-memory archive bytes inside the destination sandbox", () => {
  const sandbox = temporaryDirectory();
  try {
    const expected = Buffer.from([0, 255, 1, 2, 0, 128, 64]);
    const archive = new AdmZip();
    archive.addFile("models/bytes.bin", expected);

    const reopened = new AdmZip(archive.toBuffer());
    assert.deepEqual(reopened.readFile("models/bytes.bin"), expected);

    const destination = path.join(sandbox, "destination");
    fs.mkdirSync(destination);
    reopened.extractAllTo(destination, true);
    assert.deepEqual(fs.readFileSync(path.join(destination, "models", "bytes.bin")), expected);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("adm-zip rejects a destination symlink and never writes beyond the sandbox", (t) => {
  const sandbox = temporaryDirectory();
  try {
    const destination = path.join(sandbox, "destination");
    const outside = path.join(sandbox, "outside");
    fs.mkdirSync(destination);
    fs.mkdirSync(outside);
    try {
      fs.symlinkSync(outside, path.join(destination, "models"), "dir");
    } catch (error) {
      if (error && error.code === "EPERM") {
        t.skip("the runner cannot create symbolic links");
        return;
      }
      throw error;
    }

    const archive = new AdmZip();
    archive.addFile("models/owned.txt", Buffer.from("untrusted archive bytes"));
    const reopened = new AdmZip(archive.toBuffer());

    assert.throws(() => reopened.extractAllTo(destination, true));
    assert.equal(fs.existsSync(path.join(outside, "owned.txt")), false);
    assert.equal(fs.lstatSync(path.join(destination, "models")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
