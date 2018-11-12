var express = require('express');
var path = require('path');
var {exec, spawn} = require('child-process-promise');
var fs = require('fs');



function serve(options) {
    var {ROOT, MODULE_DIR, ACTIVE_MODULES, ACTIVE_MODULES_FILE, FORCED_MODULES, port} = options;

    var KONTROL_BIN = path.join(ROOT, 'kontrol');

    var app = express();

    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/api/context', (req, res) => {
        res.send({
            ...options,
            ACTIVE_MODULES,
            package: require(ROOT +'/package')
        });
    })

    app.get('/api/docker/status', async (req, res) => {
        var status = await exec('docker-compose ps', {
            stdio: 'inherit'
        });
        res.send(status.stdout)
    })
    app.get('/api/docker/start', async (req, res) => {
        var status = await spawn('docker-compose', ['up','-d'], {
            stdio: 'inherit'
        });
        res.send(status.stdout)
    })
    app.get('/api/docker/stop', async (req, res) => {
        var status = await spawn('docker-compose', ['stop'], {
            stdio: 'inherit'
        });
        res.send(status.stdout)
    })
    app.get('/api/mod/:name', async (req, res) => {
        try {
            var mod = require(path.join(MODULE_DIR, req.param('name'), 'module'));
            var dir = mod.directory || path.basename(mod.repository || '') || false;

            var data = {
                module: mod,
                dir,
                // git_status: await exec(`git -C ${path.join(ROOT, 'workspace', dir)} status`)
            };


            res.send(data);
        } catch (err) {
            res.status(500).send({error: err});
        }
    });
    app.post('/api/mod/:name/activate', async (req, res) => {
        await spawn(KONTROL_BIN, ['activate', req.params.name, '--restart'], {
            cwd: ROOT,
            stdio: 'inherit'
        }) 
        res.send({success: true});
        readActiveModules();
    })
    app.post('/api/mod/:name/deactivate', async (req, res) => {
        await spawn(KONTROL_BIN, ['deactivate', req.params.name, '--restart'], {
            cwd: ROOT,
            stdio: 'inherit'
        }) 
        res.send({success: true});
        readActiveModules();
    })
    // test
    app.listen(port);

    console.log("Listening on port " + port);


    function readActiveModules() {
        var modulesFromFile;
        try {
            modulesFromFile =  fs.readFileSync(ACTIVE_MODULES_FILE).toString().split("\n").filter(Boolean).filter(line => {
                return !line.match(/^\s*#/)
            })
        } catch (readError) {
            console.error(readError);
            modulesFromFile = [];
        }
        ACTIVE_MODULES = FORCED_MODULES.concat(modulesFromFile);

        console.log('ACTIVE_MODULES', ACTIVE_MODULES)
    }

}

module.exports.serve = serve;