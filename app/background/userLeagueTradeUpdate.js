"use strict";

const { Worker } = require("worker_threads");
const path = require("path");
const axios = require("axios");

const getState = async (app) => {
  try {
    const state = await axios.get("https://api.sleeper.app/v1/state/nfl");

    console.log({ WEEK: state.data.leg });

    app.set("state", state.data);
  } catch (err) {
    console.log("Error fetch NFL state: ", err.message);
  }
};

module.exports = async (app) => {
  await getState(app);
  setInterval(async () => await getState(app), 3 * 60 * 60 * 1000);

  const startUserUpdateWorker = async (worker) => {
    const state = app.get("state");

    console.log(`Beginning User Update for Week ${state.leg}...`);

    const league_ids_queue = app.get("league_ids_queue") || [];

    worker.postMessage({ league_ids_queue, state });

    worker.on("error", (error) => {
      console.error(error);
    });
    worker.once("message", (message) => {
      console.log({ queue: message.league_ids_queue_updated.length });

      try {
        app.set("league_ids_queue", message.league_ids_queue_updated);

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

  const userUpdateInterval = async () => {
    await startUserUpdateWorker(worker);

    setTimeout(userUpdateInterval, 60 * 1000);
  };

  setTimeout(userUpdateInterval, 90 * 1000);
};
