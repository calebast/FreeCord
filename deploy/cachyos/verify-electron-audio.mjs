const endpoint = process.argv[2];
if (!endpoint?.startsWith("ws://127.0.0.1:")) {
  throw new Error("Pass the local Electron DevTools websocket URL.");
}

const socket = new WebSocket(endpoint);
const pending = new Map();
let sequence = 0;

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Timed out connecting to Electron DevTools.")), 5_000);
  socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
  socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Electron DevTools websocket failed.")); }, { once: true });
});

function call(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const evaluation = await call("Runtime.evaluate", {
  expression: `(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((device) => device.kind === "audioinput" || device.kind === "audiooutput")
        .map((device) => ({ kind: device.kind, label: device.label }));
    } finally {
      stream.getTracks().forEach((track) => track.stop());
    }
  })()`,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});

if (evaluation.exceptionDetails) {
  throw new Error(evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text);
}

const devices = evaluation.result?.value;
if (!Array.isArray(devices)) throw new Error("Electron did not return an audio-device list.");
console.log(JSON.stringify(devices, null, 2));
socket.close();
