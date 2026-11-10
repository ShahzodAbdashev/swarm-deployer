# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Swarm Deployer: one connection per target. Each target has two full paths: the packages folder (where new image zips arrive) and the backup folder. The separate SFTP file server and the "folder on this computer" source are gone; set the packages folder on the target again after updating.
- A package deploys to the target it is on; with several targets the wizard asks which one.
- Work dir removed: a deploy's temporary tar goes to `<backup_dir>/.work/`.

### Added
- Initial project setup
