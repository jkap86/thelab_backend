"use strict";

const { Worker } = require("worker_threads");
const path = require("path");
const axios = require("axios");

module.exports = async (app) => {
  setTimeout(async () => {
    const state = await axios.get("https://api.sleeper.app/v1/state/nfl");

    app.set("state", state.data);
  }, 1000);

  const startUserUpdateWorker = async () => {
    console.log("Beginning User Update...");

    const worker = new Worker(
      path.resolve(__dirname, "../helpers/userUpdateHelper.js")
    );

    const state = app.get("state");
    const league_ids_queue = app.get("league_ids_queue") || [];

    worker.postMessage({ league_ids_queue, state });

    worker.on("error", (error) => console.error(error));
    worker.on("message", (message) => {
      console.log({ queue: message.league_ids_queue_updated.length });
      app.set("league_ids_queue", message.league_ids_queue_updated);
    });
    worker.on("exit", (code) => {
      if (code !== 0)
        reject(new Error(`Worker stopped with exit code ${code}`));
    });
  };

  setInterval(async () => {
    if (!app.get("syncing")) {
      await app.set("syncing", true);
      await startUserUpdateWorker();
      await app.set("syncing", false);
    } else {
      console.log("Skipping User League syncs...");
    }
    const used = process.memoryUsage();

    for (let key in used) {
      console.log(
        `${key} ${Math.round((used[key] / 1024 / 1024) * 100) / 100} MB`
      );
    }
  }, 60 * 1000);
};
