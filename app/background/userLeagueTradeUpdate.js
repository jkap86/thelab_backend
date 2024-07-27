"use strict";

const { Worker } = require("worker_threads");
const path = require("path");

module.exports = async (app) => {
  const startUserUpdateWorker = () => {
    console.log("Beginning User Update...");

    const worker = new Worker(
      path.resolve(__dirname, "../helpers/userUpdateHelper.js")
    );
  };
};
