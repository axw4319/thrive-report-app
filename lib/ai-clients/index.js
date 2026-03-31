const openaiClient = require('./openai');
const geminiClient = require('./gemini');
const serpOverviewsClient = require('./serpapi-overviews');
const perplexityClient = require('./perplexity');

const clients = [
  openaiClient,
  geminiClient,
  serpOverviewsClient,
  perplexityClient,
];

async function queryAll(promptText) {
  const results = await Promise.allSettled(
    clients.map(client =>
      client.query(promptText).then(
        response => ({ model_name: client.name, response }),
        err => {
          console.error(`  [${client.name}] Error: ${err.message}`);
          return { model_name: client.name, response: null, error: err.message };
        }
      )
    )
  );
  return results.map(r => r.value);
}

function getModelNames() {
  return clients.map(c => c.name);
}

module.exports = { queryAll, getModelNames, clients };
