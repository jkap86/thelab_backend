const express = require("express");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 3002;
require("dotenv").config();

app.use(
  cors({
    origin: "*",
  })
);

require("./app/routes/ktc.routes")(app);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);

  require("./app/background/ktcUpdate")(app);
  require("./app/background/userLeagueTradeUpdate")(app);
});
