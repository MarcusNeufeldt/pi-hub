import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    /*
     * Git worktrees created under .claude/ are full checkouts of this same
     * repository, so linting them reports every finding twice — half of them
     * against files that do not exist in a fresh clone. Build output is
     * generated and equally not ours to lint.
     */
    ignores: [".claude/**", ".next/**", "bun.lock"],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
