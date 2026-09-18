module.exports = {
    apps: [
        {
            name: "shorts-api",
            cwd: `${__dirname}/api`,
            script: "src/index.js",
            node_args: "--env-file=.env",
            instances: 1,
            exec_mode: "fork",
            env: { NODE_ENV: "production" },
            kill_timeout: 30000,
            restart_delay: 3000,
            time: true,
        },
        {
            name: "shorts-worker",
            cwd: `${__dirname}/worker`,
            script: "src/index.js",
            node_args: "--env-file=.env",
            instances: 1,
            exec_mode: "fork",
            env: { NODE_ENV: "production" },
            kill_timeout: 30000,
            restart_delay: 3000,
            time: true,
        },
    ],
};