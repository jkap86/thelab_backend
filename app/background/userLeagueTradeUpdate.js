"use strict";

const { Worker } = require("worker_threads");
const path = require("path");
const axios = require("axios");

module.exports = async (app) => {
  setTimeout(async () => {
    const state = await axios.get("https://api.sleeper.app/v1/state/nfl");

    app.set("state", state.data);
  }, 1000);

  const startUserUpdateWorker = async (worker) => {
    await app.set("syncing", true);
    console.log("Beginning User Update...");

    const state = app.get("state");
    const league_ids_queue = app.get("league_ids_queue") || [];

    worker.postMessage({ league_ids_queue, state });

    worker.on("error", (error) => console.error(error));
    worker.once("message", (message) => {
      console.log({ queue: message.league_ids_queue_updated.length });
      try {
        app.set("league_ids_queue", message.league_ids_queue_updated);
        app.set("syncing", false);
        const used = process.memoryUsage();

        for (let key in used) {
          console.log(
            `${key} ${Math.round((used[key] / 1024 / 1024) * 100) / 100} MB`
          );
        }
      } catch (err) {
        console.log(err.message);
      }
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        console.error(new Error(`Worker stopped with exit code ${code}`));
      } else {
        console.log("Worker completed successfully");
      }
    });
  };

  const worker = new Worker(
    path.resolve(__dirname, "../helpers/userUpdateHelper.js")
  );

  setTimeout(() => {
    if (!app.get("syncing")) {
      startUserUpdateWorker(worker);
    } else {
      console.log("Skipping User League syncs...");
    }
  }, 5 * 1000);

  setInterval(async () => {
    if (!app.get("syncing")) {
      await startUserUpdateWorker(worker);
    } else {
      console.log("Skipping User League syncs...");
    }
  }, 60 * 1000);
};
