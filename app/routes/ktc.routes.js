"use strict";

module.exports = (app) => {
  const router = require("express").Router();

  const ktc = require("../controllers/ktc.controller");

  router.get("/current", ktc.current);

  app.use("/ktc", router);
};
