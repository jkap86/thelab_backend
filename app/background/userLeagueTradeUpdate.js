"use strict";

const { Worker } = require("worker_threads");
const path = require("path");
const axios = require("axios");

module.exports = async (app) => {
  setTimeout(async () => {
    const state = await axios.get("https://api.sleeper.app/v1/state/nfl");

    app.set("state", state.data);
  }, 1000);

  const startUserUpdateWorker = () => {
    console.log("Beginning User Update...");

    const worker = new Worker(
      path.resolve(__dirname, "../helpers/userUpdateHelper.js")
    );

    const state = app.get("state");
    const league_ids_queue = app.get("league_ids_queue") || [];

    worker.postMessage({ league_ids_queue, state });

    worker.on("message", (message) => {
      app.set("league_ids_queue", message.league_ids_queue_updated);
    });
  };

  setInterval(() => {
    if (!app.get("syncing")) {
      app.set("syncing", true);
      startUserUpdateWorker();
      app.set("syncing", false);
    } else {
      console.log("Skipping User League syncs...");
    }
  }, 60 * 1000);
};
