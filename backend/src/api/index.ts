import express from "express";

import tokenRouter from "./routers/token.js";

const apiRouterV3 = express.Router();

apiRouterV3.use("/token", tokenRouter);

export default apiRouterV3;
