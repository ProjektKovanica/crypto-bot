module.exports = {
  apps : [{
    name   : "binance-bot",
    script : "./bot.js",
    watch  : true,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: "production"
    }
  }]
}
