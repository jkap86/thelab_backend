"use strict";

const fs = require("fs");

exports.current = (req, res) => {
  const ktc_dates_raw = fs.readFileSync("./data/KTC_dates.json", "utf-8");

  const ktc_dates = JSON.parse(ktc_dates_raw);

  const current_date = Object.keys(ktc_dates).sort(
    (a, b) => new Date(b) - new Date(a)
  )[0];

  const current_values_obj = ktc_dates[current_date];

  const current_values_array = Object.entries(current_values_obj);

  res.send({
    date: current_date,
    values: current_values_array,
  });
};
