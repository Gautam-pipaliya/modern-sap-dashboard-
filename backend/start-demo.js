// Start the workbench with a clearly labeled, read-only sample SAP environment.
process.env.DEMO_MODE = "true";
process.env.NODE_ENV = "development";
process.env.HOST = process.env.HOST || "127.0.0.1";
process.env.PORT = process.env.PORT || "3000";
require("./server");
