module.exports = {
  require: ['src/test/setup.js'],
  spec: [
    'out/test/test/**/*.test.js',
    'out/test-media/src/test/media/**/*.test.js',
    'out/test-standalone/standalone/cloud/*.test.js',
  ],
  timeout: 10000,
  ui: 'tdd',
  color: true
}
