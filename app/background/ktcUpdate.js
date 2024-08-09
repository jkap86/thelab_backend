"use strict";

const { Worker } = require("worker_threads");
const path = require("path");

module.exports = async (app) => {
  const startKtcWorker = () => {
    if (!app.get("syncing")) {
      app.set("syncing", true);
      console.log("Starting KTC update...");

      const worker = new Worker(
        path.resolve(__dirname, "../helpers/ktcUpdateHelper.js")
      );

      worker.on("error", (error) => {
        app.set("syncing", false);
        console.error(error);
      });
      worker.on("exit", (code) => {
        if (code === 0) {
          console.log("KTC update complete...");
        } else {
          console.error(`Worker stopped with exit code ${code}`);
        }
        const used = process.memoryUsage();

        for (let key in used) {
          console.log(
            `${key} ${Math.round((used[key] / 1024 / 1024) * 100) / 100} MB`
          );
        }
      });

      app.set("syncing", false);
    } else {
      console.log("Delay KTC sync 15 sec");

      setTimeout(startKtcWorker, 15000);
    }
  };

  setTimeout(() => {
    startKtcWorker();
    setInterval(startKtcWorker, 1 * 60 * 60 * 1000);
  }, 15000);
};
