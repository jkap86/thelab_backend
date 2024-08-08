"use strict";

const { parentPort } = require("worker_threads");
const pool = require("../config/db");
const {
  fetchUserLeagues,
  fetchLeague,
  fetchLeagueRosters,
  fetchLeagueUsers,
  fetchLeagueDrafts,
  fetchLeagueTradedPicks,
  fetchLeagueTransactions,
  fetchLeagueMatchups,
} = require("../api/sleeperApi");

const updateUsers = async ({ league_ids_queue, state }) => {
  if (league_ids_queue.length < 100) {
    console.log("Getting Users To Update...");

    const getUserIdsQuery = `
    SELECT user_id 
    FROM users 
    WHERE type IN ('S', 'LM')
    ORDER BY updatedAt ASC 
    LIMIT 100;
  `;

    const users_to_update = await pool.query(getUserIdsQuery);

    const league_ids_to_add = league_ids_queue;

    const batchSize = 10;

    for (let i = 0; i < users_to_update.rows.length; i += batchSize) {
      const batch = users_to_update.rows.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (user) => {
          const leagues = await fetchUserLeagues(
            user.user_id,
            state.league_season
          );

          league_ids_to_add.push(
            ...leagues
              .filter((league) => !league_ids_to_add.includes(league.league_id))
              .map((league) => league.league_id)
          );
        })
      );
    }

    return {
      league_ids_queue_updated: Array.from(new Set(league_ids_to_add)),
    };
  } else {
    return { league_ids_queue_updated: league_ids_queue };
  }
};

const updateLeagues = async ({ league_ids_queue, state }) => {
  const league_ids_to_update = league_ids_queue.slice(0, 50);

  const batchSize = 10;

  const updatedLeagues = [];

  for (let i = 0; i < league_ids_to_update.length; i += batchSize) {
    const league_ids_batch = league_ids_to_update.slice(i, i + batchSize);

    const processedLeagues = await updateLeaguesBatch(
      league_ids_batch,
      state.display_week
    );

    updatedLeagues.push(...processedLeagues);
  }

  console.log(`${updatedLeagues.length} Leagues processed...`);

  return {
    league_ids_queue_updated: league_ids_queue.filter(
      (l) => !updatedLeagues.includes(l)
    ),
  };
};

parentPort.on("message", async (message) => {
  const { league_ids_queue, state } = message;

  try {
    const result = await updateUsers({ league_ids_queue, state });

    const result2 = await updateLeagues({
      league_ids_queue: result.league_ids_queue_updated,
      state,
    });

    parentPort.postMessage(result2);
  } catch (err) {
    console.log(err.message);
  }
});

const updateLeaguesBatch = async (league_ids_batch, week) => {
  const tradesBatch = [];
  const matchupsBatch = [];
  const updatedLeaguesBatch = [];
  const usersBatch = [];
  const userLeagueBatch = [];

  const batchSize = 5;

  for (let i = 0; i < league_ids_batch.length; i += batchSize) {
    await Promise.all(
      league_ids_batch.slice(i, i + batchSize).map(async (league_id) => {
        let league_draftpicks_obj;

        try {
          const league = await fetchLeague(league_id);

          const rosters = await fetchLeagueRosters(league_id);

          const users = await fetchLeagueUsers(league_id);

          if (league.status === "in_season") {
            const matchups = await fetchLeagueMatchups(league_id, week);

            matchups.forEach((matchup) => {
              matchupsBatch.push({
                week: week,
                league_id: league.league_id,
                matchup_id: matchup.matchup_id,
                roster_id: matchup.roster_id,
                players: matchup.players,
                starters: matchup.starters,
                updatedat: new Date(),
              });
            });
          }

          let drafts;
          if (league.settings.type === 2) {
            drafts = await fetchLeagueDrafts(league_id);

            const traded_picks = await fetchLeagueTradedPicks(league_id);

            league_draftpicks_obj = getTeamDraftPicks(
              league,
              rosters,
              users,
              drafts,
              traded_picks
            );
          } else {
            league_draftpicks_obj = {};
          }

          const rosters_w_username = getRostersUsername(
            rosters,
            users,
            league_draftpicks_obj
          );

          rosters_w_username
            .filter((ru) => ru.user_id)
            .forEach((ru) => {
              if (!usersBatch.some((u) => u.user_id === ru.user_id)) {
                usersBatch.push({
                  user_id: ru.user_id,
                  username: ru.username,
                  avatar: ru.avatar,
                  type: "",
                  updatedAt: new Date(),
                  createdAt: new Date(),
                });
              }

              userLeagueBatch.push({
                user_id: ru.user_id,
                league_id: league.league_id,
              });
            });

          updatedLeaguesBatch.push({
            league_id: league.league_id,
            name: league.name,
            avatar: league.avatar,
            season: league.season,
            status: league.status,
            settings: league.settings,
            scoring_settings: league.scoring_settings,
            roster_positions: league.roster_positions,
            rosters: rosters_w_username,
            updatedat: new Date(),
          });

          const transactions = await fetchLeagueTransactions(league_id, week);

          const upcoming_draft = drafts?.find(
            (x) =>
              x.status !== "complete" &&
              x.settings.rounds === league.settings.draft_rounds
          );

          tradesBatch.push(
            ...transactions
              .filter((t) => t.type === "trade" && t.status === "complete")
              .map((t) => {
                const adds = {};
                const drops = {};

                t.adds &&
                  Object.keys(t.adds).forEach((add) => {
                    const manager = rosters_w_username.find(
                      (ru) => ru.roster_id === t.adds[add]
                    );

                    adds[add] = manager?.user_id;
                  });

                t.drops &&
                  Object.keys(t.drops).forEach((drop) => {
                    const manager = rosters_w_username.find(
                      (ru) => ru.roster_id === t.drops[drop]
                    );

                    drops[drop] = manager?.user_id;
                  });

                const draft_picks = t.draft_picks.map((dp) => {
                  const original_user_id = rosters_w_username.find(
                    (ru) => ru.roster_id === dp.roster_id
                  )?.user_id;

                  const order =
                    (upcoming_draft?.draft_order &&
                      parseInt(upcoming_draft.season) === parseInt(dp.season) &&
                      upcoming_draft.draft_order[original_user_id]) ||
                    null;

                  return {
                    round: dp.round,
                    season: dp.season,
                    new: rosters_w_username.find(
                      (ru) => ru.roster_id === dp.owner_id
                    )?.user_id,
                    old: rosters_w_username.find(
                      (ru) => ru.roster_id === dp.previous_owner_id
                    )?.user_id,
                    original: rosters_w_username.find(
                      (ru) => ru.roster_id === dp.roster_id
                    )?.user_id,
                    order: order,
                  };
                });

                return {
                  ...t,
                  league_id: league.league_id,
                  rosters: rosters_w_username.map((ru) => {
                    return {
                      rosters_id: ru.roster_id,
                      username: ru.username,
                      user_id: ru.user_id,
                      avatar: ru.avatar,
                      players: ru.players || [],
                    };
                  }),
                  draft_picks: draft_picks,
                  price_check: [""],
                  managers: Array.from(
                    new Set([
                      ...Object.values(adds || {}),
                      ...Object.values(drops || {}),
                    ])
                  ),
                  players: [
                    ...Object.keys(t.adds || {}),
                    ...draft_picks.map(
                      (pick) => `${pick.season} ${pick.round}.${pick.order}`
                    ),
                  ],
                  adds: adds,
                  drops: drops,
                };
              })
          );
        } catch (err) {
          console.log(err.message);
        }
      })
    );
  }

  try {
    try {
      await pool.query("BEGIN");
      await upsertLeagues(updatedLeaguesBatch);
      await upsertTrades(tradesBatch);
      await upsertMatchups(matchupsBatch);
      await upsertUsers(usersBatch);
      await upsertUserLeagues(userLeagueBatch);
      await pool.query("COMMIT");
      return updatedLeaguesBatch.map((league) => league.league_id);
    } catch (err) {
      await pool.query("ROLLBACK");
      console.error("Error upserting leagues:", err);
      return [];
    }
  } catch (err) {
    console.error("Error connecting to the database:", err);
    return [];
  }
};

const getRostersUsername = (rosters, users, league_draftpicks_obj) => {
  const rosters_username = rosters.map((roster) => {
    const user = users.find((user) => user.user_id === roster.owner_id);

    return {
      roster_id: roster.roster_id,
      username: user?.display_name || "Orphan",
      user_id: roster.owner_id,
      avatar: user?.avatar || null,
      players: roster.players,
      draftpicks: league_draftpicks_obj[roster.roster_id] || [],
      starters: roster.starters || [],
      taxi: roster.taxi || [],
      reserve: roster.reserve || [],
      wins: roster.settings.wins,
      losses: roster.settings.losses,
      ties: roster.settings.ties,
      fp: parseFloat(
        `${roster.settings.fpts}.${roster.settings.fpts_decimal || 0}`
      ),
      fpa: parseFloat(
        `${roster.settings.fpts_against || 0}.${
          roster.settings.fpts_against_decimal || 0
        }`
      ),
    };
  });

  return rosters_username;
};

const getTeamDraftPicks = (league, rosters, users, drafts, traded_picks) => {
  const upcoming_draft = drafts.find(
    (x) =>
      x.status !== "complete" &&
      x.settings.rounds === league.settings.draft_rounds
  );

  const draft_season = upcoming_draft
    ? parseInt(league.season)
    : parseInt(league.season) + 1;

  const draft_order = upcoming_draft?.draft_order;

  const draft_picks_league = {};

  rosters.forEach((roster) => {
    const draft_picks_team = [];

    const user = users.find((u) => u.user_id === roster.owner_id);

    // loop through seasons (draft season and next two seasons)

    for (let j = draft_season; j <= draft_season + 2; j++) {
      // loop through rookie draft rounds

      for (let k = 1; k <= league.settings.draft_rounds; k++) {
        // check if each rookie pick is in traded picks

        const isTraded = traded_picks.find(
          (pick) =>
            parseInt(pick.season) === j &&
            pick.round === k &&
            pick.roster_id === roster.roster_id
        );

        // if it is not in traded picks, add to original manager

        if (!isTraded) {
          draft_picks_team.push({
            season: j,
            round: k,
            roster_id: roster.roster_id,
            original_user: {
              avatar: user?.avatar || "",
              user_id: roster.owner_id,
              username: user?.display_name || "Orphan",
            },
            order:
              (draft_order &&
                j === parseInt(upcoming_draft.season) &&
                draft_order[roster?.owner_id]) ||
              null,
          });
        }
      }
    }

    traded_picks
      .filter(
        (x) =>
          x.owner_id === roster.roster_id && parseInt(x.season) >= draft_season
      )
      .forEach((pick) => {
        const original_roster = rosters.find(
          (t) => t.roster_id === pick.roster_id
        );

        const original_user = users.find(
          (u) => u.user_id === original_roster?.owner_id
        );

        original_roster &&
          draft_picks_team.push({
            season: parseInt(pick.season),
            round: pick.round,
            roster_id: pick.roster_id,
            original_user: {
              avatar: original_user?.avatar || "",
              user_id: original_user?.user_id || "",
              username: original_user?.display_name || "Orphan",
            },
            order:
              (original_user &&
                draft_order &&
                parseInt(pick.season) === parseInt(upcoming_draft.season) &&
                draft_order[original_user?.user_id]) ||
              null,
          });
      });

    traded_picks
      .filter(
        (x) =>
          x.previous_owner_id === roster.roster_id &&
          parseInt(x.season) >= draft_season
      )
      .forEach((pick) => {
        const index = draft_picks_team.findIndex((obj) => {
          return (
            obj.season === parseInt(pick.season) &&
            obj.round === pick.round &&
            obj.roster_id === pick.roster_id
          );
        });

        if (index !== -1) {
          draft_picks_league[roster.roster_id].splice(index, 1);
        }
      });

    draft_picks_league[roster.roster_id] = draft_picks_team;
  });

  return draft_picks_league;
};

const upsertLeagues = async (updatedLeagues) => {
  const upsertLeaguesQuery = `
    INSERT INTO leagues (league_id, name, avatar, season, status, settings, scoring_settings, roster_positions, rosters, updatedat)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (league_id) DO UPDATE SET
      name = EXCLUDED.name,
      avatar = EXCLUDED.avatar,
      season = EXCLUDED.season,
      status = EXCLUDED.status,
      settings = EXCLUDED.settings,
      scoring_settings = EXCLUDED.scoring_settings,
      roster_positions = EXCLUDED.roster_positions,
      rosters = EXCLUDED.rosters,
      updatedat = EXCLUDED.updatedat;
  `;

  for (const league of updatedLeagues) {
    try {
      await pool.query(upsertLeaguesQuery, [
        league.league_id,
        league.name,
        league.avatar,
        league.season,
        league.status,
        JSON.stringify(league.settings),
        JSON.stringify(league.scoring_settings),
        JSON.stringify(league.roster_positions),
        JSON.stringify(league.rosters),
        league.updatedat,
      ]);
    } catch (err) {
      console.log(err.message);
    }
  }
};

const upsertTrades = async (trades) => {
  const upsertTradesQuery = `
    INSERT INTO trades (transaction_id, status_updated, adds, drops, draft_picks, price_check, rosters, managers, players, league_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (transaction_id) DO UPDATE SET
      draft_picks = EXCLUDED.draft_picks;
  `;

  for (const trade of trades) {
    try {
      await pool.query(upsertTradesQuery, [
        trade.transaction_id,
        trade.status_updated,
        JSON.stringify(trade.adds),
        JSON.stringify(trade.drops),
        JSON.stringify(trade.draft_picks),
        trade.price_check,
        JSON.stringify(trade.rosters),
        trade.managers,
        trade.players,
        trade.league_id,
      ]);
    } catch (err) {
      console.log(err.message);
    }
  }
};

const upsertMatchups = async (matchups) => {
  const upsertMatchupsQuery = `
    INSERT INTO matchups (week, matchup_id, roster_id, players, starters, league_id, updatedat)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (week, roster_id, league_id) DO UPDATE SET
      matchup_id = EXCLUDED.matchup_id,
      players = EXCLUDED.players,
      starters = EXCLUDED.starters,
      updatedat = EXCLUDED.updatedat
  `;

  for (const matchup of matchups) {
    try {
      await pool.query(upsertMatchupsQuery, [
        matchup.week,
        matchup.matchup_id,
        matchup.roster_id,
        matchup.players,
        matchup.starters,
        matchup.league_id,
        matchup.updatedat,
      ]);
    } catch (err) {
      console.log(err.message);
    }
  }
};

const upsertUsers = async (users) => {
  const upsertUsersQuery = `
    INSERT INTO users (user_id, username, avatar, type, updatedat, createdat)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (user_id) DO UPDATE SET
      username = EXCLUDED.username,
      avatar = EXCLUDED.avatar,
      updatedat = EXCLUDED.updatedAt;
  `;

  for (const user of users) {
    try {
      await pool.query(upsertUsersQuery, [
        user.user_id,
        user.username,
        user.avatar,
        user.type,
        user.updatedAt,
        user.createdAt,
      ]);
    } catch (err) {
      console.log(err.message);
    }
  }
};

const upsertUserLeagues = async (userLeagues) => {
  const upsertUserLeaguesQuery = `
    INSERT INTO userLeagues (user_id, league_id)
    VALUES ($1, $2)
    ON CONFLICT DO NOTHING
  `;

  for (const userLeague of userLeagues) {
    try {
      await pool.query(upsertUserLeaguesQuery, [
        userLeague.user_id,
        userLeague.league_id,
      ]);
    } catch (err) {
      console.log(err.message);
    }
  }
};
