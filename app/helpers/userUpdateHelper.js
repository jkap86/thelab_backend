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

          const league_ids = leagues.map((league) => league.league_id);

          const existingLeaguesQuery = `
            SELECT league_id
            FROM leagues
            WHERE league_id = ANY($1)
            ORDER BY updatedat ASC;
          `;

          const existingLeague_ids = await pool.query(existingLeaguesQuery, [
            league_ids,
          ]);

          const newLeague_ids = league_ids.filter(
            (league_id) =>
              !league_ids_to_add.includes(league_id) &&
              !existingLeague_ids.rows
                .map((r) => r.league_id)
                .includes(league_id)
          );

          league_ids_to_add.push(...newLeague_ids);
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
  const league_ids_to_update = league_ids_queue.slice(0, 100);

  if (league_ids_to_update.length < 100) {
    const outOfDateLeaguesQuery = `
      SELECT league_id
      FROM leagues
      ORDER BY updatedat ASC
      LIMIT $1;
    `;

    const outOfDateLeagues = await pool.query(outOfDateLeaguesQuery, [
      100 - league_ids_to_update.length,
    ]);

    const outOfDateLeagueIds = outOfDateLeagues.rows.map((l) => l.league_id);

    league_ids_to_update.push(...outOfDateLeagueIds);
  }

  const batchSize = 5;

  const updatedLeagues = [];

  for (let i = 0; i < league_ids_to_update.length; i += batchSize) {
    const league_ids_batch = league_ids_to_update.slice(i, i + batchSize);

    const processedLeagues = await updateLeaguesBatch(
      league_ids_batch,
      state.season_type === "pre"
        ? 1
        : state.season_type === "post"
        ? 18
        : state.display_week
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

  await Promise.all(
    league_ids_batch.map(async (league_id) => {
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
            x.draft_order && x.settings.rounds === league.settings.draft_rounds
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
                rosters: rosters_w_username,
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
        if (err.response?.status === 404) {
          const deleteQuery = `
            DELETE FROM leagues WHERE league_id = $1;
          `;

          const deleted = await pool.query(deleteQuery, [league_id]);

          console.log(`${deleted.rowCount} leagues deleted - ${league_id}`);
        } else {
          console.log(err.message + " " + league_id);
        }
      }
    })
  );

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
  if (updatedLeagues.length === 0) return;

  const upsertLeaguesQuery = `
    INSERT INTO leagues (league_id, name, avatar, season, status, settings, scoring_settings, roster_positions, rosters, updatedat)
    VALUES ${updatedLeagues
      .map(
        (_, i) =>
          `($${i * 10 + 1}, $${i * 10 + 2}, $${i * 10 + 3}, $${i * 10 + 4}, $${
            i * 10 + 5
          }, $${i * 10 + 6}, $${i * 10 + 7}, $${i * 10 + 8}, $${i * 10 + 9}, $${
            i * 10 + 10
          })`
      )
      .join(", ")}
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

  const values = updatedLeagues.flatMap((league) => [
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

  try {
    await pool.query(upsertLeaguesQuery, values);
  } catch (err) {
    console.log(err.message + " LEAGUES");
  }
};

const upsertTrades = async (trades) => {
  if (trades.length === 0) return;

  const upsertTradesQuery = `
    INSERT INTO trades (transaction_id, status_updated, adds, drops, draft_picks, price_check, rosters, managers, players, league_id)
     VALUES ${trades
       .map(
         (_, i) =>
           `($${i * 10 + 1}, $${i * 10 + 2}, $${i * 10 + 3}, $${i * 10 + 4}, $${
             i * 10 + 5
           }, $${i * 10 + 6}, $${i * 10 + 7}, $${i * 10 + 8}, $${
             i * 10 + 9
           }, $${i * 10 + 10})`
       )
       .join(", ")}
    ON CONFLICT (transaction_id) DO UPDATE SET
      draft_picks = EXCLUDED.draft_picks;
  `;

  const values = trades.flatMap((trade) => [
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

  try {
    await pool.query(upsertTradesQuery, values);
  } catch (err) {
    console.log(err.message + " TRADES");
  }
};

const upsertMatchups = async (matchups) => {
  if (matchups.length === 0) return;

  const upsertMatchupsQuery = `
    INSERT INTO matchups (week, matchup_id, roster_id, players, starters, league_id, updatedat)
    VALUES ${matchups
      .map(
        (_, i) =>
          `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${
            i * 7 + 5
          }, $${i * 7 + 6}, $${i * 7 + 7})`
      )
      .join(", ")}
    ON CONFLICT (week, roster_id, league_id) DO UPDATE SET
      matchup_id = EXCLUDED.matchup_id,
      players = EXCLUDED.players,
      starters = EXCLUDED.starters,
      updatedat = EXCLUDED.updatedat
  `;

  const values = matchups.flatMap((matchup) => [
    matchup.week,
    matchup.matchup_id,
    matchup.roster_id,
    matchup.players,
    matchup.starters,
    matchup.league_id,
    matchup.updatedat,
  ]);

  try {
    await pool.query(upsertMatchupsQuery, values);
  } catch (err) {
    console.log(err.message + " MATCHUPS");
  }
};

const upsertUsers = async (users) => {
  if (users.length === 0) return;

  const upsertUsersQuery = `
    INSERT INTO users (user_id, username, avatar, type, updatedat, createdat)
    VALUES ${users
      .map(
        (_, i) =>
          `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${
            i * 6 + 5
          }, $${i * 6 + 6})`
      )
      .join(", ")}
    ON CONFLICT (user_id) DO UPDATE SET
      username = EXCLUDED.username,
      avatar = EXCLUDED.avatar,
      updatedat = EXCLUDED.updatedAt;
  `;

  const values = users.flatMap((user) => [
    user.user_id,
    user.username,
    user.avatar,
    user.type,
    user.updatedAt,
    user.createdAt,
  ]);

  try {
    await pool.query(upsertUsersQuery, values);
  } catch (err) {
    console.log(err.message + " USERS");
  }
};

const upsertUserLeagues = async (userLeagues) => {
  if (userLeagues.length === 0) return;

  const upsertUserLeaguesQuery = `
    INSERT INTO userLeagues (user_id, league_id)
    VALUES ${userLeagues
      .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`)
      .join(", ")}
    ON CONFLICT DO NOTHING
  `;

  const values = userLeagues.flatMap((userLeague) => [
    userLeague.user_id,
    userLeague.league_id,
  ]);

  try {
    await pool.query(upsertUserLeaguesQuery, values);
  } catch (err) {
    console.log(err.message + " USERLEAGUES");
  }
};
