#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./app.js";

const instance = render(React.createElement(App), { exitOnCtrlC: false });
void instance.waitUntilExit().then(() => process.exit(0));
