{
  description = "Nix flake for a simple Node DevShell";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [ inputs.flake-parts.flakeModules.easyOverlay ];
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      perSystem =
        {
          config,
          self',
          inputs',
          pkgs,
          system,
          final,
          ...
        }:
        {
          formatter = pkgs.alejandra;

          devShells = {
            default = pkgs.mkShell {
              buildInputs = with pkgs; [
                nodejs_24
                eslint_d
                prettierd
                corepack_22
              ];
            };
          };
        };
    };
}
