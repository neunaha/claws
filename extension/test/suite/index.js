const path = require('path');
const Mocha = require('mocha');
const glob = require('glob');

function run() {
  const timeout = Number(process.env.MOCHA_TIMEOUT) || 10000;
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout,
  });

  const testsRoot = path.resolve(__dirname, '..');

  return new Promise((resolve, reject) => {
    const globPattern = path.join(testsRoot, 'suite', '**', '*.test.js');
    glob.glob(globPattern, (err, files) => {
      if (err) {
        return reject(err);
      }

      files.slice().sort().forEach((file) => mocha.addFile(path.resolve(file)));

      try {
        mocha.run((failures) => {
          if (failures > 0) {
            reject(new Error(`${failures} tests failed.`));
          } else {
            resolve();
          }
        });
      } catch (err) {
        console.error(err);
        reject(err);
      }
    });
  });
}

module.exports = { run };
