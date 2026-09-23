const path = require("node:path");
const Mocha = require("mocha");

exports.run = () => new Promise((resolve, reject) => {
  const mocha = new Mocha({ ui: "tdd", color: true });
  mocha.addFile(path.resolve(__dirname, "extension-suite.cjs"));
  mocha.run((failures) => {
    if (failures > 0) reject(new Error(`${failures} VS Code integration test(s) failed.`));
    else resolve();
  });
});
