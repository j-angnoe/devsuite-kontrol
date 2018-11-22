var path = require('path');
var glob = require('glob');
var fs = require('fs');

module.exports.listModules = listModules

function findRootDir(root) {
    var dir = root || process.cwd();
    while(dir > '/') {
        if (fs.existsSync(path.join(dir, 'kontrolrc.js'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    throw new Error(`Could not find a kontrolrc.js file from ` + process.cwd() + '`');
}

function openJson(file) {
    return JSON.parse(fs.readFileSync(file));
}
function readActiveModules(file) {
    var modulesFromFile;
    try {
        modulesFromFile =  fs.readFileSync(file).toString().split("\n").filter(Boolean).filter(line => {
            return !line.match(/^\s*#/)
        })
    } catch (readError) {
        modulesFromFile = [];
    }
    return modulesFromFile;
}

function listModules({root}) {

    var ROOT = findRootDir(root);
    var MODULE_DIR = path.join(ROOT, 'modules');

    console.log("Listmodules from " + ROOT);


    var INTERNAL_MODULES = glob.sync(path.join(MODULE_DIR,'*','module.json')).map(file => {
        return path.basename(path.dirname(file))
    });
    var MODULE_BUNDLES = [];
    try { 
        MODULE_BUNDLES = openJson(path.join(MODULE_DIR, 'bundles.json'));
    } catch (ignore) {
        console.info(`Warning: error reading module bundles.json: ${ignore}`)
    } 

    var ACTIVE_MODULES_FILE = path.join(MODULE_DIR, '.active');
    var ACTIVE_MODULES = readActiveModules(ACTIVE_MODULES_FILE).concat(MODULE_BUNDLES['default']||[]);

    var INTERNAL_MODULES = INTERNAL_MODULES.map(mod => {
        return {
            name: mod,
            path: path.join(MODULE_DIR, mod),
            status: ~ACTIVE_MODULES.indexOf(mod) ? 'active' : 'inactive'
        }
    });
    var kontrolRc = {}
    try { 
        kontrolRc = require(path.join(ROOT, 'kontrolrc'));
    } catch(ignore) {
        console.info(`Warning: error opening kontrolrc: ${ignore}`)
    }
    var EXTERNAL_MODULES = [];

    if (kontrolRc && kontrolRc.listModuleDirectories) {
        [].concat(kontrolRc.listModuleDirectories()).map(dir => {
            // test multimodule stuff: .kontrol/modulename/module.json files.
            // find singlemodule stuff: .kontrol/module.json
            var files = glob.sync(path.join(dir, '*', '.kontrol', '**', 'module.json'));
            
            EXTERNAL_MODULES = EXTERNAL_MODULES.concat(files).map(file => {
                var obj = require(file);

                return {
                    name: obj.name,
                    path: path.dirname(file),
                    status: ~ACTIVE_MODULES.indexOf(obj.name) ? 'active' : 'inactive'
                }
            });
        })
    }
    return EXTERNAL_MODULES.concat(INTERNAL_MODULES);
}
