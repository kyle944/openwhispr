const boundSenders = new WeakSet();

function bindInferenceLeaseOwner(sender, releaseOwner) {
  if (boundSenders.has(sender)) return false;
  boundSenders.add(sender);
  const ownerId = sender.id;
  const release = () => {
    void Promise.resolve(releaseOwner(ownerId, "owner-gone")).catch(() => {});
  };
  sender.on("did-start-navigation", release);
  sender.on("render-process-gone", release);
  sender.once("destroyed", release);
  return true;
}

module.exports = { bindInferenceLeaseOwner };
