const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Descarga e instala Chromium directamente dentro de la carpeta del proyecto (.chromium)
  cacheDirectory: join(__dirname, '.chromium'),
};

