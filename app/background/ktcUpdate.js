"use strict";

const { Worker } = require("worker_threads");
const path = require("path");

module.exports = async () => {
  const startKtcWorker = () => {
    console.log("Starting KTC update...");

    const worker = new Worker(
      path.resolve(__dirname, "../helpers/ktcUpdateHelper.js")
    );

    worker.on("error", (error) => console.error(error));
    worker.on("exit", (code) => {
      if (code === 0) {
        console.log("KTC update complete...");
      } else {
        console.error(`Worker stopped with exit code ${code}`);
      }
    });
  };

  setTimeout(() => {
    startKtcWorker();

    setInterval(startKtcWorker, 1 * 60 * 60 * 1000);
  }, 5000);
};
