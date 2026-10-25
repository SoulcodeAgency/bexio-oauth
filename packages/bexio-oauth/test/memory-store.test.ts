import { memoryStore } from "../src/index.js";
import { storeContract } from "./store-contract.js";

storeContract("memory", async () => memoryStore());
