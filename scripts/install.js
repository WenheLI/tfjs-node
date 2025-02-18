/**
 * @license
 * Copyright 2019 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

const fs = require('fs');
let path = require('path');
const rimraf = require('rimraf');
const util = require('util');
const cp = require('child_process');
const os = require('os');
const {
  depsPath,
  depsLibPath,
  depsLibTensorFlowPath,
  getLibTensorFlowMajorDotMinorVersion,
  LIBTENSORFLOW_VERSION,
  modulePath
} =
require('./deps-constants.js');
const resources = require('./resources');
const {
  addonName
} = require('./get-addon-name.js');

const exists = util.promisify(fs.exists);
const mkdir = util.promisify(fs.mkdir);
const rename = util.promisify(fs.rename);
const rimrafPromise = util.promisify(rimraf);

const BASE_URI =
  'https://storage.googleapis.com/tensorflow/libtensorflow/libtensorflow-';
const CPU_DARWIN = `cpu-darwin-x86_64-${LIBTENSORFLOW_VERSION}.tar.gz`;
const CPU_LINUX = `cpu-linux-x86_64-${LIBTENSORFLOW_VERSION}.tar.gz`;
const GPU_LINUX = `gpu-linux-x86_64-${LIBTENSORFLOW_VERSION}.tar.gz`;
const CPU_WINDOWS = `cpu-windows-x86_64-${LIBTENSORFLOW_VERSION}.zip`;
const GPU_WINDOWS = `gpu-windows-x86_64-${LIBTENSORFLOW_VERSION}.zip`;

// TODO(kreeger): Update to TensorFlow 1.13:
// https://github.com/tensorflow/tfjs/issues/1369
const TF_WIN_HEADERS_URI =
  `https://storage.googleapis.com/tf-builds/tensorflow-headers-` +
  `${getLibTensorFlowMajorDotMinorVersion()}.zip`;

const platform = os.platform();
let libType = process.argv[2] === undefined ? 'cpu' : process.argv[2];
let forceDownload = process.argv[3] === undefined ? undefined : process.argv[3];

async function updateAddonName() {
  const file = JSON.parse(fs.readFileSync(`${__dirname}/../package.json`).toString());
  file['binary']['package_name'] = addonName;
  const stringFile = JSON.stringify(file, null, 2)
  fs.writeFile((`${__dirname}/../package.json`), stringFile, err => {
    if (err) {
      console.log('Faile to update addon name in package.json: ' + err);
    }
  });
}

/**
 * Returns the libtensorflow hosted path of the current platform.
 */
function getPlatformLibtensorflowUri() {
  let targetUri = BASE_URI;
  if (platform === 'linux') {
    if (os.arch() === 'arm') {
      // TODO(kreeger): Update to TensorFlow 1.14:
      // https://github.com/tensorflow/tfjs/issues/1370
      targetUri =
        'https://storage.googleapis.com/tf-builds/libtensorflow_r1_12_linux_arm.tar.gz';
    } else {
      if (libType === 'gpu') {
        targetUri += GPU_LINUX;
      } else {
        targetUri += CPU_LINUX;
      }
    }
  } else if (platform === 'darwin') {
    targetUri += CPU_DARWIN;
  } else if (platform === 'win32') {
    // Use windows path
    path = path.win32;
    if (libType === 'gpu') {
      targetUri += GPU_WINDOWS;
    } else {
      targetUri += CPU_WINDOWS;
    }
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  return targetUri;
}

/**
 * Ensures a directory exists, creates as needed.
 */
async function ensureDir(dirPath) {
  if (!await exists(dirPath)) {
    await mkdir(dirPath);
  }
}

/**
 * Deletes the deps directory if it exists, and creates a fresh deps folder.
 */
async function cleanDeps() {
  if (await exists(depsPath)) {
    await rimrafPromise(depsPath);
  }
  await mkdir(depsPath);
}

/**
 * Downloads libtensorflow and notifies via a callback when unpacked.
 */
async function downloadLibtensorflow(callback) {
  // Ensure dependencies staged directory is available:
  await ensureDir(depsPath);

  console.warn('* Downloading libtensorflow');
  resources.downloadAndUnpackResource(
    getPlatformLibtensorflowUri(), depsPath, async () => {
      if (platform === 'win32') {
        // Some windows libtensorflow zip files are missing structure and the
        // eager headers. Check, restructure, and download resources as
        // needed.
        const depsIncludePath = path.join(depsPath, 'include');
        if (!await exists(depsLibTensorFlowPath)) {
          // Verify that tensorflow.dll exists
          const libtensorflowDll = path.join(depsPath, 'tensorflow.dll');
          if (!await exists(libtensorflowDll)) {
            throw new Error('Could not find libtensorflow.dll');
          }

          await ensureDir(depsLibPath);
          await rename(libtensorflowDll, depsLibTensorFlowPath);
        }

        // The shipped headers for Windows libtensorflow are old - remove and
        // download the latest:
        if (await exists(depsIncludePath)) {
          await rimrafPromise(depsIncludePath);
        }

        // Download the C headers only and unpack:
        resources.downloadAndUnpackResource(
          TF_WIN_HEADERS_URI, depsPath, () => {
            if (callback !== undefined) {
              callback();
            }
          });
      } else {
        // No other work is required on other platforms.
        if (callback !== undefined) {
          callback();
        }
      }
    });
}

/**
 * Calls node-gyp for Node.js Tensorflow binding after lib is downloaded.
 */
async function build() {
  console.error('* Building TensorFlow Node.js bindings');
  cp.exec('node-pre-gyp install --fallback-to-build', (err) => {
    if (err) {
      console.log('node-pre-gyp install failed with error: ' + err);
    }
    if (platform === 'win32') {
      // Move libtensorflow to module path, where tfjs_binding.node locates.
      cp.exec('node scripts/deps-stage.js symlink ' + modulePath);
    }
  });
}

/**
 * Ensures libtensorflow requirements are met for building the binding.
 */
async function run() {
  // Update addon name in package.json file
  await updateAddonName();
  // First check if deps library exists:
  if (forceDownload !== 'download' && await exists(depsLibTensorFlowPath)) {
    // Library has already been downloaded, then compile and simlink:
    await build();
  } else {
    // Library has not been downloaded, download, then compile and symlink:
    await cleanDeps();
    await downloadLibtensorflow(build);
  }
}

run();
