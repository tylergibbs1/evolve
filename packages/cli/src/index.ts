#!/usr/bin/env bun
import { Command } from "commander";
import { init } from "./init.ts";
import { run } from "./run.ts";
import { results } from "./results.ts";

const program = new Command()
  .name("evolve")
  .description(
    "Evolve — Metacognitive self-improving agent framework.\n" +
      "Based on the Darwin Godel Machine with Hyperagents (DGM-H).",
  )
  .version("0.1.0");

program
  .command("init")
  .description("Initialize a new Evolve project")
  .argument("[dir]", "Target directory", ".")
  .action(async (dir: string) => {
    await init(dir);
  });

program
  .command("run")
  .description("Run the evolution loop")
  .option("-n, --iterations <number>", "Number of iterations", "10")
  .option("-k, --k <number>", "Parallel parents per iteration", "2")
  .option("-d, --dir <path>", "Project directory", ".")
  .option("-c, --config <path>", "Path to config file")
  .action(async (opts) => {
    await run({
      iterations: parseInt(opts.iterations, 10),
      k: parseInt(opts.k, 10),
      dir: opts.dir,
      configPath: opts.config,
    });
  });

program
  .command("results")
  .description("Display archive contents and evolution progress")
  .option("-d, --dir <path>", "Project directory", ".")
  .option("-t, --top <number>", "Number of top agents to show", "10")
  .action((opts) => {
    results({
      dir: opts.dir,
      top: parseInt(opts.top, 10),
    });
  });

program.parse();
