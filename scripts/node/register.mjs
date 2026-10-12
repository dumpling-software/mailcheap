// Lets node (tests, scripts) load app modules: "@/x" resolves like jsconfig's alias, extensionless imports get
// .js, and Next-only modules ("server-only", next/cache, next/headers) become no-op stand-ins.
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
