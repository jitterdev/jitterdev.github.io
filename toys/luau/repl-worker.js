// Runs luau-web in a worker so a runaway script can be killed without hanging
// the tab. The VM is created once and kept alive, so globals persist between
// inputs. On a timeout the main thread terminates this worker and respawns it.
import { LuauState } from "./luauweb.min.js";

let state = null;
let ready = false;
let buffer = [];

function fmt(value, depth) {
  depth = depth || 0;
  if (value === undefined || value === null) return "nil";
  const type = typeof value;
  if (type === "string") return value;
  if (type === "number" || type === "boolean" || type === "bigint") return String(value);
  if (type === "function") return "<function>";
  if (depth > 3) return "...";
  if (Array.isArray(value)) {
    return "{" + value.map(function (v) { return fmt(v, depth + 1); }).join(", ") + "}";
  }
  if (type === "object" && typeof value.keys === "function" && typeof value.get === "function") {
    const parts = [];
    for (const key of value.keys()) {
      parts.push(fmt(key, depth + 1) + " = " + fmt(value.get(key), depth + 1));
    }
    return "{" + parts.join(", ") + "}";
  }
  if (type === "object") {
    try { return JSON.stringify(value); } catch (err) { return "<table>"; }
  }
  return String(value);
}

self.onmessage = async function (event) {
  const msg = event.data || {};
  if (msg.type !== "run") return;
  if (!ready) {
    self.postMessage({ type: "error", error: "runtime is still loading" });
    return;
  }

  buffer = [];
  let error = null;
  try {
    const fn = compile(msg.code);
    const results = await fn();
    if (results && results.length) {
      buffer.push(results.map(function (r) { return fmt(r); }).join("\t"));
    }
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  }
  self.postMessage({ type: "result", output: buffer.join("\n"), error: error });
};

// REPL-ish input handling: try the line as an expression first so `1 + 2`
// prints a value, then fall back to a plain chunk for statements like
// `local x = 1` or multi-line code.
function compile(code) {
  try {
    return state.loadstring("return " + code, "repl", true);
  } catch (expressionError) {
    try {
      return state.loadstring(code, "repl", true);
    } catch (statementError) {
      throw statementError;
    }
  }
}

LuauState.createAsync({
  // Redirect luau's print into our output buffer. This is the only host
  // function exposed to the runtime.
  print: function () {
    buffer.push(Array.prototype.map.call(arguments, function (a) {
      return fmt(a);
    }).join("\t"));
  },
}).then(function (created) {
  state = created;
  ready = true;
  self.postMessage({ type: "ready" });
}).catch(function (err) {
  self.postMessage({
    type: "error",
    error: "failed to load luau: " + (err && err.message ? err.message : err),
  });
});
