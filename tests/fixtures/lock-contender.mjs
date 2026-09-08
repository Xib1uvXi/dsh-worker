import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [home, barriers, role] = process.argv.slice(2);
const lock = join(fs.realpathSync(home), "controller.lock");
const unlink = fs.unlinkSync;
let first = true;
// Pause at the old-lock deletion boundary to force the previously unsafe order.
fs.unlinkSync = function (path) {
  if (path === lock && first) {
    first = false;
    fs.writeFileSync(join(barriers, role + "-paused"), "");
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(join(barriers, role + "-resume"))) {
      if (Date.now() > deadline) throw new Error("lock barrier timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return unlink(path);
};
syncBuiltinESMExports();
const { Controller } = await import("../../dist/index.js");
try {
  const controller = new Controller({
    home,
    runtime: {
      execute() {
        throw new Error("unused runtime");
      },
    },
  });
  process.send({ opened: true });
  process.on("message", async () => {
    await controller.close();
    process.exit(0);
  });
} catch (error) {
  process.send({ opened: false, error: String(error) });
  process.exit(1);
}
