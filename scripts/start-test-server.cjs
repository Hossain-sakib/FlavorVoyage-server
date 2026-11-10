// Browser tests use a separate temporary database, populated explicitly.
const { createApp } = require("../app");
const initialState = require("../tools/demo/state.cjs")();
createApp({
  initialState,
  dataFile: process.env.DATA_FILE,
  origin: process.env.APP_ORIGIN,
  demo: true,
}).listen(process.env.PORT || 5003, "127.0.0.1");
