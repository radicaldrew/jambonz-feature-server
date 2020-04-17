const assert = require('assert');
const noopLogger = {info: () => {}, error: () => {}};
const {LifeCycleEvents} = require('./constants');
const Emitter = require('events');
const debug = require('debug')('jambonz:feature-server');

module.exports = (logger) => {
  logger = logger || noopLogger;
  let idxSbc = 0;

  assert.ok(process.env.JAMBONES_SBCS, 'missing JAMBONES_SBCS env var');
  const sbcs = process.env.JAMBONES_SBCS
    .split(',')
    .map((sbc) => sbc.trim());
  assert.ok(sbcs.length, 'JAMBONES_SBCS env var is empty or misconfigured');
  logger.info({sbcs}, 'SBC inventory');

  // listen for SNS lifecycle changes
  let lifecycleEmitter = new Emitter();
  let dryUpCalls = false;
  if (process.env.AWS_SNS_TOPIC_ARM &&
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_REGION) {

    (async function() {
      try {
        lifecycleEmitter = await require('./aws-sns-lifecycle')(logger);
        lifecycleEmitter.operationalState = 'normal';

        lifecycleEmitter
          .on(LifeCycleEvents.ScaleIn, () => {
            logger.info('AWS scale-in notification: begin drying up calls');
            lifecycleEmitter.operationalState = LifeCycleEvents.ScaleIn;
            lifecycleEmitter.unsubscribe();
            dryUpCalls = true;

            // if we have zero calls, we can complete the scale-in right now
            const {sessionTracker} = require('../../').locals;
            if (sessionTracker.count === 0) {
              //TODO: signal scale-in can complete immediately
              /**
               * aws autoscaling complete-lifecycle-action \
               * --lifecycle-hook-name my-lifecycle-hook \
               * --auto-scaling-group-name my-auto-scaling-group \
               * --lifecycle-action-result CONTINUE \
               * --lifecycle-action-token bcd2f1b8-9a78-44d3-8a7a-4dd07d7cf635
               */
            }
          })
          .on(LifeCycleEvents.PendingEnter, () => {
            lifecycleEmitter.operationalState = LifeCycleEvents.PendingEnter;
            dryUpCalls = true;
            logger.info('AWS enter pending state notification: begin drying up calls');
          })
          .on(LifeCycleEvents.PendingExit, () => {
            dryUpCalls = false;
            lifecycleEmitter.operationalState = 'normal';
            logger.info('AWS enter pending state notification: re-enable calls');
          });
      } catch (err) {
        logger.error({err}, 'Failure creating SNS notifier, lifecycle events will be disabled');
      }
    })();
  }

  // send OPTIONS pings to SBCs
  async function pingProxies(srf) {
    for (const sbc of sbcs) {
      try {
        const ms = srf.locals.getFreeswitch();
        const req = await srf.request({
          uri: `sip:${sbc}`,
          method: 'OPTIONS',
          headers: {
            'X-FS-Status': ms && !dryUpCalls ? 'open' : 'closed'
          }
        });
        req.on('response', (res) => {
          debug(`received ${res.status} from SBC`);
        });
      } catch (err) {
        logger.error(err, `Error sending OPTIONS to ${sbc}`);
      }
    }
  }

  // OPTIONS ping the SBCs from each feature server every 60 seconds
  setInterval(() => {
    const {srf} = require('../..');
    pingProxies(srf);
  }, 60000);

  return {
    lifecycleEmitter,
    getSBC: () => sbcs[idxSbc++ % sbcs.length]
  };
};

