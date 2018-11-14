var express = require('express');
var path = require('path');
var {exec, spawn} = require('child-process-promise');
var fs = require('fs');



function serve(options) {
    var {ROOT, MODULES, ACTIVE_MODULES, FORCED_MODULES, port, getModule, readActiveModules} = options;

    var KONTROL_BIN = path.join(ROOT, 'kontrol');

    var app = express();

    app.use(express.static(path.join(__dirname, 'public')));

    // Never expose your entire node_modules map in production systems!
    app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));

    app.get('/api/context', (req, res) => {
        res.send({
            MODULES,
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
        var name = req.params.name;

        try {
            // Read module.json
            var mod = require(path.join(getModule(name).path, 'module'));

            // dir from module.json
            var dir = mod.directory || path.basename(mod.repository || '') || false;

            var data = {
                module: mod,
                dir,
                // git_status: await exec(`git -C ${path.join(ROOT, 'workspace', dir)} status`)
            };


            res.send(data);
        } catch (err) {
            console.log(`GET /api/mod/${name} - 500`)
            console.error(err);
            res.status(500).send({error: err});
        }
    });
    app.post('/api/mod/:name/activate', async (req, res) => {
        await spawn(KONTROL_BIN, ['activate', req.params.name, '--restart'], {
            cwd: ROOT,
            stdio: 'inherit'
        }) 

        ACTIVE_MODULES = readActiveModules();

        res.send({success: true});

        
    })
    app.post('/api/mod/:name/deactivate', async (req, res) => {
        await spawn(KONTROL_BIN, ['deactivate', req.params.name, '--restart'], {
            cwd: ROOT,
            stdio: 'inherit'
        }) 

        ACTIVE_MODULES = readActiveModules();

        res.send({success: true});
        
    })
    // test
    app.listen(port);

    console.log("Listening on port " + port);
}

module.exports.serve = serve;