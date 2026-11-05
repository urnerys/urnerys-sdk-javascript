{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    nix-develop.url = "github:nicknovitski/nix-develop";
    nix-develop.inputs.nixpkgs.follows = "nixpkgs";

    shell-brief.url = "github:wereHamster/shell-brief";
  };

  outputs =
    {
      nixpkgs,
      nix-develop,
      shell-brief,
      ...
    }:
    let
      forAllSystems =
        function: nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed (system: function nixpkgs.legacyPackages.${system});

    in
    {
      packages = forAllSystems (pkgs: {
        nix-develop = nix-develop.packages.${pkgs.stdenv.hostPlatform.system}.default;
      });

      devShells = forAllSystems (
        pkgs:
        let
          brief = shell-brief.lib.mkShellBrief {
            inherit pkgs;

            banner = ''
              ${pkgs.figlet}/bin/figlet urnerys sdk
            '';

            setup = [
              {
                name = "Dependencies";
                condition = "[[ -d node_modules && node_modules -nt pnpm-lock.yaml ]]";
                suggestion = "Run 'pnpm install'";
              }
            ];

            commands = [
              {
                name = "pnpm";
                help = "Manage Node.js dependencies";
              }
              {
                name = "biome";
                help = "Lint and format the code";
              }
            ];
          };

        in
        {
          default = pkgs.mkShell {
            nativeBuildInputs = [
              pkgs.nodejs
              pkgs.pnpm
              pkgs.biome

              brief
            ];

            shellHook = ''
              ${brief}/bin/brief
            '';
          };

          agent = pkgs.mkShell {
            nativeBuildInputs = [
              pkgs.nodejs
              pkgs.pnpm
              pkgs.biome

              (pkgs.writeShellScriptBin "setup" ''
                set -euo pipefail

                pnpm install --frozen-lockfile
              '')
            ];
          };

          workflow = pkgs.mkShell {
            nativeBuildInputs = [
              pkgs.nodejs
              pkgs.pnpm
              pkgs.biome
            ];
          };
        }
      );
    };
}
