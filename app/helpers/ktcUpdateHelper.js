"use strict";
const { chromium } = require("playwright");
const cheerio = require("cheerio");
const fs = require("fs");

const formatName = (name) => {
  return name
    .replace("Marquise", "Hollywood")
    .replace("Jr", "")
    .replace("III", "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
};

const matchKtcToSleeperId = (player_value_obj) => {
  const ktcMapping_raw = fs.readFileSync("./data/KtcIdMapping.json", "utf-8");
  const ktcMapping = JSON.parse(ktcMapping_raw);

  let sleeper_id;

  if (player_value_obj.position === "PI") {
    sleeper_id = player_value_obj.name;
  } else {
    const link_array = player_value_obj.link.split("-");

    sleeper_id = ktcMapping[link_array[link_array.length - 1]];
  }

  return sleeper_id;
};

const getDailyKtcValues = async () => {
  console.log("Getting Daily KTC values...");
  const browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const page = await browser.newPage();

  const ktc_dates_raw = fs.readFileSync("./data/KTC_dates.json");
  const ktc_players_raw = fs.readFileSync("./data/KTC_players.json");
  const ktc_unmatched_raw = fs.readFileSync("./data/KTC_unmatched.json");

  const ktc_dates = JSON.parse(ktc_dates_raw);
  const ktc_players = JSON.parse(ktc_players_raw);
  const ktc_unmatched = JSON.parse(ktc_unmatched_raw);

  for await (const key of Array.from(Array(10).keys())) {
    try {
      await page.goto(
        `https://keeptradecut.com/dynasty-rankings?page=${key}filters=QB|WR|RB|TE|RDP&format=2`
      );

      const html = await page.content();

      const $ = cheerio.load(html);

      const players = $("div.onePlayer");

      players.each((index, element) => {
        const player = $(element);

        const name_link = player.find(
          ".single-ranking-wrapper div.single-ranking div.player-name p a"
        );

        const name = name_link.text();
        const link = name_link.attr("href");

        const team = player
          .find(
            ".single-ranking-wrapper div.single-ranking div.player-name p span.player-team"
          )
          .text();

        const position__pos_rank = player
          .find(
            ".single-ranking-wrapper div.single-ranking div.position-team p.position"
          )
          .text();

        const position = position__pos_rank.slice(0, 2);
        const pos_rank = position__pos_rank.slice(2, position__pos_rank.length);

        const value = player
          .find(".single-ranking-wrapper div.single-ranking div.value p")
          .text();

        const date = new Date().toISOString().split("T")[0];

        const player_value_obj = { name, link, team, position, value, date };
        const sleeper_id = matchKtcToSleeperId(player_value_obj);

        if (sleeper_id) {
          if (!ktc_dates[date]) {
            ktc_dates[date] = {};
          }

          if (!ktc_players[sleeper_id]) {
            ktc_players[sleeper_id] = {
              name: player_value_obj.name,
              link: player_value_obj.link,
              team: player_value_obj.team,
              position: player_value_obj.position,
              values: {},
            };
          }

          ktc_dates[date][sleeper_id] = parseInt(value);

          ktc_players[sleeper_id].values[date] = parseInt(value);
        } else {
          ktc_unmatched[player_value_obj.name] = player_value_obj;
        }
      });
    } catch (err) {
      console.log(err.message);
    }
  }

  await browser.close();

  fs.writeFileSync("./data/KTC_dates.json", JSON.stringify(ktc_dates));
  fs.writeFileSync("./data/KTC_players.json", JSON.stringify(ktc_players));
  fs.writeFileSync("./data/KTC_unmatched.json", JSON.stringify(ktc_unmatched));

  console.log("Getting Daily KTC values COMPLETE!");
};

const createInitialKTCFile = () => {
  console.log("Creating Initial KTC File...");
  const values_array_day_raw = fs.readFileSync(
    "./data/ktc__7_22_24.json",
    "utf-8"
  );

  const values_array_day = JSON.parse(values_array_day_raw);

  const ktcData = {
    dates: {},
    players: {},
    unmatched: {},
  };

  const total = values_array_day.length;

  values_array_day.forEach((player_value_obj, index) => {
    console.log(`${index + 1} of ${total}...`);

    const sleeper_id = matchKtcToSleeperId(player_value_obj);

    if (sleeper_id) {
      if (!ktcData.dates[player_value_obj.date]) {
        ktcData.dates[player_value_obj.date] = {};
      }

      if (!ktcData.players[sleeper_id]) {
        ktcData.players[sleeper_id] = {
          name: player_value_obj.name,
          link: player_value_obj.link,
          team: player_value_obj.team,
          position: player_value_obj.position,
          values: {},
        };
      }

      ktcData.dates[player_value_obj.date][sleeper_id] = player_value_obj.value;

      ktcData.players[sleeper_id].values[player_value_obj.date] =
        player_value_obj.value;
    } else {
      ktcData.unmatched[player_value_obj.name] = player_value_obj.link;
    }
  });

  fs.writeFileSync("./data/ktcValues.json", JSON.stringify(ktcData));

  console.log("KTC File Created!!!");
};

const matchUnmatchedKTC = () => {
  const KtcData_raw = fs.readFileSync("./data/ktcValues.json", "utf-8");

  const ktcData = JSON.parse(KtcData_raw);

  const unmatched = ktcData.unmatched;

  const ktcDataUpdated = {
    ...ktcData,
    unmatched: [],
  };

  const total = unmatched.length;

  unmatched.forEach((player_value_obj, index) => {
    console.log(`${index + 1} of ${total}...`);
    if (player_value_obj.position !== "PI") {
      const sleeper_id = matchKtcToSleeperId(player_value_obj);

      if (sleeper_id) {
        if (!ktcDataUpdated.dates[player_value_obj.date]) {
          ktcDataUpdated.dates[player_value_obj.date] = [];
        }

        if (!ktcDataUpdated.players[sleeper_id]) {
          ktcDataUpdated.players[sleeper_id] = {
            name: player_value_obj.name,
            link: player_value_obj.link,
            team: player_value_obj.team,
            position: player_value_obj.position,
            values: [],
          };
        }

        ktcDataUpdated.dates[player_value_obj.date].push({
          sleeper_id: sleeper_id,
          value: player_value_obj.value,
        });

        ktcDataUpdated.players[sleeper_id].values.push({
          date: player_value_obj.date,
          pos_rank: player_value_obj.pos_rank,
          value: player_value_obj.value,
        });
      } else {
        ktcDataUpdated.unmatched.push(player_value_obj);
      }
    } else {
      if (!ktcDataUpdated.dates[player_value_obj.date]) {
        ktcDataUpdated.dates[player_value_obj.date] = [];
      }

      if (!ktcDataUpdated.players[player_value_obj.name]) {
        ktcDataUpdated.players[player_value_obj.name] = {
          name: player_value_obj.name,
          link: player_value_obj.link,
          values: [],
        };
      }

      ktcDataUpdated.dates[player_value_obj.date].push({
        sleeper_id: player_value_obj.name,
        value: player_value_obj.value,
      });

      ktcDataUpdated.players[player_value_obj.name].values.push({
        date: player_value_obj.date,
        value: player_value_obj.value,
      });
    }
  });

  fs.writeFileSync("./data/ktcValues.json", JSON.stringify(ktcDataUpdated));
};

const syncKtcPlayersHistories = async () => {
  console.log("Begin KTC Players History sync...");

  const ktcAll_raw = fs.readFileSync("./data/ktcValuesAlltime.json", "utf-8");
  const ktcAll = JSON.parse(ktcAll_raw);

  const browser = await puppeteer.launch();

  const page = await browser.newPage();

  const total = Object.keys(ktcAll.players).filter(
    (sleeper_id) => !(Object.keys(ktcAll.players[sleeper_id].values).length > 1)
  ).length;

  for await (const [index, sleeper_id] of Object.keys(ktcAll.players)
    .filter(
      (sleeper_id) =>
        !(Object.keys(ktcAll.players[sleeper_id].values).length > 1)
    )
    .slice(0, 50)
    .entries()) {
    console.log(`${index + 1}:${sleeper_id} of ${total}`);
    const link = ktcAll.players[sleeper_id].link;

    await page.goto("https://keeptradecut.com" + link);

    await page.click(
      "div.pd-block.pd-value-graph div.block-top div.block-controls div.block-config div#all-time"
    );

    const player_value_obj = {
      name: ktcAll.players[sleeper_id].name,
      link: link,
      position: ktcAll.players[sleeper_id].position,
      team: ktcAll.players[sleeper_id].team,
    };

    const html = await page.content();

    const $ = cheerio.load(html);

    const graph = $("div.pd-value-graph");
    const dates = graph.find("g.hoverGroup");

    dates.each((index, element) => {
      const date_element = $(element);

      const date_raw = date_element.find("text.hoverDate").text();

      const date = new Date(date_raw).toISOString().split("T")[0];

      const value = date_element.find("text.hoverVal").text();

      if (sleeper_id) {
        if (!ktcAll.dates[date]) {
          ktcAll.dates[date] = {};
        }

        if (!ktcAll.players[sleeper_id]) {
          ktcAll.players[sleeper_id] = {
            name: player_value_obj.name,
            link: player_value_obj.link,
            team: player_value_obj.team,
            position: player_value_obj.position,
            values: {},
          };
        }

        ktcAll.dates[date][sleeper_id] = value;

        ktcAll.players[sleeper_id].values[date] = value;
      } else {
        ktcAll.unmatched[player_value_obj.name] = player_value_obj.link;
      }
    });
  }

  await browser.close();

  fs.writeFileSync("./data/ktcValuesAlltime.json", JSON.stringify(ktcAll));
  console.log("KTC Players History sync complete...");
};

const splitFile = () => {
  const ktcAll_raw = fs.readFileSync("./data/ktcValuesAlltime.json", "utf-8");
  const ktcAll = JSON.parse(ktcAll_raw);

  const ktc_dates = ktcAll.dates;

  const ktc_players = ktcAll.players;

  const ktc_unmatched = ktcAll.unmatched;

  const ktc_dates_updated = {};

  Object.keys(ktc_dates).forEach((date) => {
    ktc_dates_updated[date] = {};

    Object.keys(ktc_dates[date]).forEach((player_id) => {
      ktc_dates_updated[date][player_id] = parseInt(ktc_dates[date][player_id]);
    });
  });

  const ktc_players_updated = {};

  Object.keys(ktc_players).forEach((player_id) => {
    ktc_players_updated[player_id] = { ...ktc_players[player_id], values: {} };

    Object.keys(ktc_players[player_id].values).forEach((date) => {
      ktc_players_updated[player_id].values[date] = parseInt(
        ktc_players[player_id].values[date]
      );
    });
  });

  fs.writeFileSync("./data/KTC_dates.json", JSON.stringify(ktc_dates_updated));

  fs.writeFileSync(
    "./data/KTC_players.json",
    JSON.stringify(ktc_players_updated)
  );

  fs.writeFileSync("./data/KTC_unmatched.json", JSON.stringify(ktc_unmatched));
};

const createKtcSleeperIdsMapping = () => {
  const ktc_players_raw = fs.readFileSync("./data/KTC_players.json");

  const ktc_players = JSON.parse(ktc_players_raw);

  const ktcMapping = {};

  Object.keys(ktc_players).forEach((sleeper_id) => {
    const link_array = ktc_players[sleeper_id].link.split("-");

    const ktc_id = link_array[link_array.length - 1];

    console.log({ ktc_id, sleeper_id });
    ktcMapping[ktc_id] = sleeper_id;
  });

  fs.writeFileSync("./data/KtcIdMapping.json", JSON.stringify(ktcMapping));
};
getDailyKtcValues();
