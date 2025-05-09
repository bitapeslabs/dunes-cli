import fs from "fs";
import path from "path";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { bip32 } from "@/lib/crypto/wallet";
import { BIP32Interface } from "bip32";
import * as bip39 from "bip39";
import { z } from "zod";

import { Command } from "@/commands/base";
import {
  decryptWalletWithPassword,
  SavedWallet,
  getCurrentTaprootAddress,
} from "@/lib/crypto/wallet";
import {
  esplora_getutxos,
  esplora_getaddressbalance,
  esplora_getfee,
  esplora_broadcastTx,
} from "@/lib/apis/esplora";
import { getDunestoneTransaction } from "@/lib/dunes";
import { getWitnessUtxo } from "@/lib/crypto/wallet";
import { DEFAULT_ERROR } from "@/lib/consts";
import { isBoxedError } from "@/lib/utils/boxed";
import { getDecryptedWalletFromPassword, getWallet } from "../shared";

type Step =
  | "divisibility"
  | "premine"
  | "dune"
  | "symbol"
  | "turbo"
  | "includeTerms"
  | "amount"
  | "cap"
  | "heightMin"
  | "heightMax"
  | "offsetMin"
  | "offsetMax"
  | "includePrice"
  | "priceAmount"
  | "pricePayTo";

export default class Etch extends Command {
  static override description = "Create a Dunestone etching and build a tx";
  static override examples = ["$ dunes etch"];

  private async promptLoop(): Promise<any> {
    const state: Record<string, any> = {};
    const steps: Step[] = [
      "divisibility",
      "premine",
      "dune",
      "symbol",
      "turbo",
      "includeTerms",
      "amount",
      "cap",
      "heightMin",
      "heightMax",
      "offsetMin",
      "offsetMax",
      "includePrice",
      "priceAmount",
      "pricePayTo",
    ];

    let idx = 0;

    while (idx < steps.length) {
      const step = steps[idx];
      const answer = await inquirer.prompt([
        this.getQuestion(step, state) as any,
      ]);

      // back support
      if (answer[step] === "/back") {
        if (idx === 0) {
          this.warn("Already at first question");
        } else {
          delete state[step];
          idx -= 1;
        }
        continue;
      }

      state[step] = answer[step];

      // dynamic flow
      if (step === "includeTerms" && !answer.includeTerms) {
        // skip all term steps
        idx = steps.indexOf("includePrice");
        continue;
      }
      if (step === "includePrice" && !answer.includePrice) {
        // skip price steps
        idx = steps.indexOf("pricePayTo"); // will be incremented below
      }

      idx += 1;
    }
    return state;
  }

  private getQuestion(step: Step, state: Record<string, any>) {
    switch (step) {
      case "divisibility":
        return {
          type: "number",
          name: step,
          message: "Divisibility (0‑255):",
          validate: (v: any) =>
            Number.isInteger(v) && v >= 0 && v <= 255
              ? true
              : "Enter u8 (0‑255)",
        };
      case "premine":
        return {
          type: "input",
          name: step,
          message: "Premine amount (u128 string):",
        };
      case "dune":
        return {
          type: "input",
          name: step,
          message: "Dune name (1‑31 chars A‑Z a‑z 0‑9 _ . -):",
        };
      case "symbol":
        return {
          type: "input",
          name: step,
          message: "Symbol (1 char, e.g., 🌵 or $):",
          validate: (s: string) =>
            s === "/back" || ([...s].length === 1 ? true : "Must be 1 char"),
        };
      case "turbo":
        return {
          type: "confirm",
          name: step,
          message: "Enable turbo? (default yes)",
          default: true,
        };
      case "includeTerms":
        return {
          type: "confirm",
          name: step,
          message: "Include Terms section?",
          default: false,
        };
      case "amount":
      case "cap":
        return {
          when: () => state.includeTerms,
          type: "input",
          name: step,
          message: `Terms.${step} (u128 string):`,
        };
      case "heightMin":
      case "heightMax":
        return {
          when: () => state.includeTerms,
          type: "input",
          name: step,
          message: `Terms.height ${
            step === "heightMin" ? "min" : "max"
          } (u32 or empty):`,
        };
      case "offsetMin":
      case "offsetMax":
        return {
          when: () => state.includeTerms,
          type: "input",
          name: step,
          message: `Terms.offset ${
            step === "offsetMin" ? "min" : "max"
          } (u32 or empty):`,
        };
      case "includePrice":
        return {
          when: () => state.includeTerms,
          type: "confirm",
          name: step,
          message: "Include price sub‑terms?",
          default: false,
        };
      case "priceAmount":
        return {
          when: () => state.includeTerms && state.includePrice,
          type: "input",
          name: step,
          message: "Price.amount (u128 string):",
        };
      case "pricePayTo":
        return {
          when: () => state.includeTerms && state.includePrice,
          type: "input",
          name: step,
          message: "Price.pay_to (max 130 chars):",
        };
      default:
        throw new Error("Unknown step");
    }
  }

  public override async run(): Promise<void> {
    const walletResponse = await getWallet(this);

    if (isBoxedError(walletResponse)) {
      this.error(`Failed to fetch wallet: ${walletResponse.message}`);
      return;
    }

    const wallet = walletResponse.data;

    const walletSignerResult = await getDecryptedWalletFromPassword(
      this,
      wallet
    );

    if (isBoxedError(walletSignerResult)) {
      this.error(`Failed to fetch mnemonic: ${walletSignerResult.message}`);
      return;
    }

    const { signer: walletSigner } = walletSignerResult.data;

    this.log(
      chalk.bold("\nDunestone Etching Wizard (type '/back' to go back)\n")
    );
    const answers = await this.promptLoop();

    const etching: any = {
      divisibility: Number(answers.divisibility),
      premine: answers.premine,
      dune: answers.dune,
      symbol: answers.symbol,
      turbo: answers.turbo,
      terms: null,
    };

    if (answers.includeTerms) {
      const terms: any = {
        amount: answers.amount,
        cap: answers.cap,
        height: [
          answers.heightMin ? Number(answers.heightMin) : null,
          answers.heightMax ? Number(answers.heightMax) : null,
        ],
        offset: [
          answers.offsetMin ? Number(answers.offsetMin) : null,
          answers.offsetMax ? Number(answers.offsetMax) : null,
        ],
      };
      if (answers.includePrice) {
        terms.price = {
          amount: answers.priceAmount,
          pay_to: answers.pricePayTo,
        };
      }
      etching.terms = terms;
    }

    const dunestoneJson = { etching };

    const txBuilderResponse = getDunestoneTransaction(dunestoneJson, {
      address: wallet.currentAddress,
      walletSigner,
      sendDunes: true, // or false if just sending BTC
    });

    if (isBoxedError(txBuilderResponse)) {
      this.error(txBuilderResponse.message ?? DEFAULT_ERROR + `(etch-1)`);
      return;
    }

    const txBuilder = txBuilderResponse.data;

    const buildSpinner = ora("Building transaction...").start();
    try {
      await txBuilder.build();
      buildSpinner.succeed("Transaction built.");
    } catch (err) {
      buildSpinner.fail("Failed to build transaction.");
      this.error(err instanceof Error ? err.message : String(err));
      return;
    }

    const txSpinner = ora("Broadcasting transaction...").start();
    const transaction = await txBuilder.finalize();

    let response = await esplora_broadcastTx(transaction.toHex());

    if (isBoxedError(response)) {
      txSpinner.fail("Failed to broadcast transaction.");
      this.error(response.message ?? DEFAULT_ERROR + `(etch-2)`);
      return;
    }

    const txid = response.data;
    txSpinner.succeed("Transaction broadcasted.");
    this.log(chalk.grey(`\nTransaction ID: ${txid}`));
  }
}
