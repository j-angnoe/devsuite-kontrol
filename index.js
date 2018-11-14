#!/usr/bin/env node

/**
 * Development Suite Kontroller
 **/

const fs = require('fs');
const path = require('path');
const glob = require('glob');
const {spawn,exec} = require('child-process-promise');

const ROOT = fs.realpathSync(path.join(__dirname,'..'));

const MODULE_DIR = path.join(ROOT, 'modules');
const ACTIVE_MODULES_FILE = path.join(MODULE_DIR, '.active');
var GIT_CLONE_OPTIONS = process.env.GIT_CLONE_OPTIONS || [];

try { 
    var kontrolRc = require(ROOT + '/kontrolrc');
} catch (errorLoadingKontrolRc) {
    console.log("Problem loading your kontrolrc.js, did you create it?");
    console.error(errorLoadingKontrolRc);
    process.exit(1);
}

var kontrolRcSharedServices = {
    spawn,
    exec,
    registerPostInstall
}

var POST_INSTALLS = [];
function registerPostInstall(item) {
    POST_INSTALLS.push(item);
}
async function runPostInstalls() {
    for (item of POST_INSTALLS) {
        try { 
            await item();
        } catch (error) {
            console.error(error);
        }
    }
}

try { 
    var MODULE_BUNDLES = require(path.join(MODULE_DIR, 'bundles'));
} catch (exception) {
    var MODULE_BUNDLES = {};
}

const FORCED_MODULES = MODULE_BUNDLES['default'] || [];

var ACTIVE_MODULES = FORCED_MODULES.concat([]);

readActiveModules();

const MODULES = listModules();

var MODULE_CHOICES = MODULES.map(m => m.name).concat(Object.keys(MODULE_BUNDLES));

// Starts cli dispatch
require('yargs')
    .option('verbose', {
        alias: 'v',
        describe: 'Put on verbose logging'
    })
    .option('restart', {
        describe: 'Automatically perform docker-compose restart if needed',
        default: false,
    })
    .command({
        command: 'generate',
        aliases: ['gen','g'],
        desc: 'Generates dynamic kahuna gateway config and docker-compose.yml',
        handler: command_generate
    })
    .command({
        command: 'activate <module>',
        desc: 'Activate a module',
        aliases: ['install','i'],
        builder: (yargs) => {
            yargs.choices('module', MODULE_CHOICES)
        },  
        handler: command_activate_module
    })
    .command({
        command: 'deactivate <module>',
        desc: 'Deactivate a module',
        aliases: ['uninstall'],
        builder: yargs => {
            yargs.choices('module', MODULE_CHOICES)
            yargs.option('delete', {
                desc: 'Delete the associated directory'
            })
        },
        handler: command_deactivate_module
    })
    .command('list', 'List available modules', {}, () => {
        console.log("Available modules:")
        console.log(listModules().map(m => {
            return ` - ${m.name} (${m.path.replace(ROOT, '')})\n`
        }));
    })
    .command({
        command: 'info <module>',
        desc: 'Show module info',
        builder: (yargs) => {
            yargs.choices('module', MODULE_CHOICES)
        },  
        handler: (argv) => {
            var mod = getModule(argv.module)
            console.log({
                module: mod,
                files: glob.sync(path.join(mod.path, '*'))
            });
        }
    })
    .command('status', 'List module status', {}, () => {
        console.log("Module status");
        MODULES.map(mod => {
            var status = ~ACTIVE_MODULES.indexOf(mod.name) ? 'active' : 'inactive';
            console.log(`${mod.name}: ${status}`)
        })
    })
    .command({
        command: 'serve',
        desc: 'Simple web-frontend for kontrol',
        builder(yargs) {
            yargs.option('port', {default: 9000});
        },  
        handler: async (argv) => {
            var server_path = path.join(__dirname, 'server');

            if (!fs.existsSync(server_path + '/node_modules')) {
                console.log("Installing server deps...");
                await spawn('npm', ['install'], {
                    cwd: server_path,
                    stdio: 'inherit'
                });
            }

            require('./server/index.js').serve({
                ROOT,
                getModule,
                readActiveModules,
                MODULES,
                ACTIVE_MODULES,
                ACTIVE_MODULES_FILE,
                FORCED_MODULES,
                MODULE_BUNDLES,
                port: argv.port
            });
        }
    })
    .demandCommand(1)
    .help()
    .argv
;

function listModules() {
    var INTERNAL_MODULES = glob.sync(path.join(MODULE_DIR,'*','module.json')).map(file => {
        return path.basename(path.dirname(file))
    });
    
    var ACTIVE_MODULES = readActiveModules();

    var INTERNAL_MODULES = INTERNAL_MODULES.map(mod => {
        return {
            name: mod,
            path: path.join(MODULE_DIR, mod),
            status: ~ACTIVE_MODULES.indexOf(mod) ? 'active' : 'inactive'
        }
    });

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

function getModule(name) {
    var mods = listModules();
    return mods.find(m => m.name == name);
}

async function command_generate(argv) {
    const DEBUG = argv && argv.verbose;

    console.log("Generating dynamic configs...");

    var modulesMap = listModules();

    if ('generate' in kontrolRc) {
        var promises = kontrolRc.generate.map(async (work) => {
            console.log(`Processing instruction '${work.name}'`);

            if (work.find) {
                
                var files = modulesMap.map(({name, path, status}) => {
                    var filesToFind = work.find.map(file => file.replace(/\{status\}/g, status))
                    return existingFile(path, filesToFind);
                }).filter(Boolean)

                DEBUG && console.info(`${work.name} found files ${files.join("\n")}`);

                var result = Promise.all(files.map(read))

                if (work.map) {    
                    result = result.then(contents => {
                        return "\n" + contents.map(work.map).join("\n") + "\n";
                    }).catch(error => {
                        console.log(`Error in kontrolrc.js generate[${work.name}].map: ${error}`)
                        process.exit(1);
                    })
                }

                if (work.join) {
                    result = result.then(work.join)
                        .catch(error => {
                            console.log(`Error in kontrolrc.js generate[${work.name}].join: ${error}`)
                            process.exit(1);                                
                        })
                }

                if (work.output) {
                    result = result.then(writeToFile(path.join(ROOT, work.output)))
                        .then((content) => {
                            DEBUG && console.info(`${work.name} output: ${content}`)
                            console.log(`${work.name} - written ${work.output}`)
                        })
                }
                await result
            }
        });
        await Promise.all(promises);
    }

    await handle_restart_option(argv);
}

async function handle_restart_option(argv) {
    var mayRestart = argv && argv.restart;

    if (mayRestart) {
        console.log("Restarting docker-compose for you...");
        // Please note: docker-compose stop + up !== docker-compose restart ;-)
        await spawn('docker-compose', ['stop'], {stdio: 'inherit'});
        await spawn('docker-compose', ['up','-d','--remove-orphans'], {stdio: 'inherit'});
    }
}

async function command_activate_module(argv) {
    var module = normalizeModuleName(argv.module);

    try { 
        if (MODULES.find(n => n.name == module)) {
            await _activate_single_module(module);
        } else if (module in MODULE_BUNDLES) {
            // Sequential, because of interactivity.
            for (let m of MODULE_BUNDLES[module]) {
                await _activate_single_module(m);
            }
        }

    } catch (error) {
        console.error(error);
        console.log("Could not activate module " + module);

        process.exit(1);
    }
    
    // Strip restart option, we'll do it ourselves
    // after handling post installs.
    var argvCopy = {...argv};
    if ('restart' in argvCopy) {
        delete argvCopy['restart'];
    }

    await command_generate(argvCopy);        

    await runPostInstalls();

    await handle_restart_option(argv);
}

async function _activate_single_module(name) {

    console.log("Activating module " + name);

    var module = getModule(name);
    if (!module) {
        throw new(`Module ${name} could not be found.`);
    }
    var moduleObject = require(`${module.path}/module`);

    const conf = kontrolRc && kontrolRc.activate || false

    // Handle dependencies
    var deps = moduleObject.dependencies || [];
    await Promise.all(deps.map(async (dep) => {
        if (!~ACTIVE_MODULES.indexOf(dep)) {
            console.log(`${dep} is a dependency of ${name}, activating it..`);
            await _activate_single_module(dep);
        }
    }));

    if (moduleObject.deactivate) {
        // may be a string, or an array of strings.
        var deactivate = [].concat(moduleObject.deactivate);
        await Promise.all(deactivate.map(async (dea) => {
            console.log(`${dea} needs to be deactivated by ${name}`)
            await _deactivate_single_module(dea);
        }));
    }
    

    // Download and install 
    if (moduleObject.repository) { 
        let repo = moduleObject.repository;
        
        if (!~repo.indexOf('://') ) {
            // Its not a absolute repository path.
            if (conf && conf.resolveRepository) {
                repo = conf.resolveRepository(repo);
            }
        }

        var repo_dir;
        repo_dir = moduleObject.directory || path.basename(repo);
        if (!(conf && conf.resolveDirectory)) {
            console.log('Please configure ./kontrolrc activate.resolveDirectory')
            process.exit(1);
        }
        repo_dir = conf.resolveDirectory(repo_dir);
        

        console.log("Repo: " + repo);
        console.log("Repo dir: " + repo_dir);

        if (!fs.existsSync(repo_dir)) {
            console.log("The repo does not exist");
            await clone(repo, repo_dir)

        } else {
            console.log("The repo does exist");
        }
    }

    if (hasPluginHandler(conf)) {
        var handler = getPluginHandler(conf);
        await handler(moduleObject, kontrolRcSharedServices);
    }

    var installScript = path.join(MODULE_DIR, name, 'install'); 
    if (fs.existsSync(installScript)) {
        console.log(`Running module install script (${installScript})`);
        await spawn(installScript, {
            cwd: repo_dir,
            stdio: 'inherit'
        })
    }

    // Post install scripts will only run if the entire 
    // install (including dependencies) is succesful.
    var postInstallScript = path.join(MODULE_DIR, name, 'postinstall'); 
    if (fs.existsSync(postInstallScript)) {
        console.log(`Registering install script (${postInstallScript})`);
        registerPostInstall(() => {
            return spawn(postInstallScript, {
                cwd: repo_dir,
                stdio: 'inherit'
            })
        });
    }
    
    if (!~ACTIVE_MODULES.indexOf(name)) {
        console.info("Adding module to ACTIVE_MODULES");
        ACTIVE_MODULES.push(name);
    } else {
        console.info("Module was already in ACTIVE_MODULES");
    }

    // Write to ACTIVE_MODULES_FILE
    writeActiveModulesFile();

}

async function command_deactivate_module(argv) {

    var module = normalizeModuleName(argv.module);

    if (MODULES.find(n => n.name === module)) {
       await _deactivate_single_module(module, argv);
    } else if (module in MODULE_BUNDLES) {
        await Promise.all(MODULE_BUNDLES[module].map(m => _deactivate_single_module(m, argv)))
    }    

    command_generate(argv);
}
async function _deactivate_single_module(name, argv) {
    argv = argv || {};

    var module = getModule(name);

    if (!module) {
        throw new(`Module ${name} could not be found.`);
    }
    var moduleObject = require(`${module.path}/module`);

    const conf = kontrolRc || false

    if (!~ACTIVE_MODULES.indexOf(name)) {
        console.log(`Module ${name} is not active.`);
        return;
    }

    if (~FORCED_MODULES.indexOf(name)) {
        console.log(`${name} is a mandatory module and will not be deactived.`)
        return;
    }

    if (hasPluginHandler(conf && conf.deactivate)) {
        var handler = getPluginHandler(conf.deactivate);
        await handler(moduleObject, kontrolRcSharedServices)
    }

    // Remote module from ACTIVE_MODULES:
    ACTIVE_MODULES = ACTIVE_MODULES.filter(mod => mod !== name)

    if (argv['delete']) {
        let repo_dir = moduleObject.directory || path.basename(moduleObject.repository);

        if (!(conf && conf.activate && conf.activate.resolveDirectory)) {   
            console.log('Please configure ./kontrolrc activate.resolveDirectory')
            process.exit(1);
        }

        repo_dir = conf.activate.resolveDirectory(repo_dir);
        
        if (repo_dir.indexOf(ROOT) == -1) {
            console.error(`The directory (${repo_dir}) we want to delete is not absolute or lies outside of ${ROOT}. Refusing to go forward.`);
            process.exit(1);
        }

        console.log(`Deleting directory ${repo_dir}`);

        await spawn('rm', ['-rf', repo_dir], {stdio: 'inherit'});
    }


    writeActiveModulesFile();


    console.log(`Deactivated ${name}`);
}

function normalizeModuleName(mod) {
    return (""+mod).replace(/\s*(^\/|\/$)\s*/, '');
}

function clone(repo, dir) {
    return spawn('git', ['clone', repo, ...GIT_CLONE_OPTIONS, dir], { stdio: 'inherit' })
}

function existingFile(directory, files) {
    for (let f of files) {
        let p = path.join(directory, f)
        if (fs.existsSync(p)) {
            return p
        }
    }            
}

function writeToFile(file) {
    return content => {
        fs.writeFileSync(file, content);

        return content
    }
}

function read(file) {
    return new Promise((resolve,reject) => {
        if (!file) {
            return reject(`No file ${file}`)
        }
        fs.readFile(file, {encoding: 'utf8'}, function (err, content) {
            if (err) reject(err)
            else resolve({file, content})
        })
    })
}

function readActiveModules() {
    var modulesFromFile;
    try {
        modulesFromFile =  fs.readFileSync(ACTIVE_MODULES_FILE).toString().split("\n").filter(Boolean).filter(line => {
            return !line.match(/^\s*#/)
        })
    } catch (readError) {
        modulesFromFile = [];
    }
    ACTIVE_MODULES = FORCED_MODULES.concat(modulesFromFile);

    return ACTIVE_MODULES;
}

function writeActiveModulesFile() {
    var mods = ACTIVE_MODULES.filter(mod => !~FORCED_MODULES.indexOf(mod))
    fs.writeFileSync(ACTIVE_MODULES_FILE, mods.join("\n"));
}

function hasPluginHandler(source) {
    return source && ('handler' in source || 'handlers' in source);
}

function getPluginHandler(source) {
    if ('handler' in source) {
        return source['handler'];
    }

    if ('handlers' in source) {
        var handler = (function makeHandler(handlers) {
            // This async function will be the return of getPluginHandler
            return async function (...args) {
                for (h of handlers.filter(Boolean)) {
                    await h.apply(null, args)
                }
            };
        })(source['handlers'])

        return handler;
    }
}