/*
 * Z2M external converter for AlexMKX/zigbee-dense smlight_slzb06mu_dense_zigbee_router firmware.
 * Spec: docs/superpowers/specs/2026-04-19-zigbee-dense-debug-logging-design.md
 *
 * Install:
 *   cp z2m/slzb06mu_dense_router.js <z2m-data>/external_converters/
 *   # then in configuration.yaml:
 *   # external_converters:
 *   #   - slzb06mu_dense_router.js
 */
const { Zcl } = require('zigbee-herdsman');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const ea = exposes.access;

const CLUSTER = 0xFC00;
const MFG = 0x1002;

const DBG_BITS = {
    stack:     1 << 0,
    core:      1 << 1,
    app:       1 << 2,
    zcl:       1 << 3,
    route:     1 << 4,
    aps_in:    1 << 5,
    heartbeat: 1 << 6,
};

const fzDebug = {
    cluster: CLUSTER.toString(),
    type: ['attributeReport', 'readResponse'],
    convert: (model, msg, publish, options, meta) => {
        const out = {};
        const d = msg.data;
        if (Object.prototype.hasOwnProperty.call(d, 0x0000)) {
            const g = d[0x0000];
            for (const [k, b] of Object.entries(DBG_BITS)) {
                out[`debug_${k}`] = (g & b) !== 0;
            }
            out.debug_groups_raw = g;
        }
        if (Object.prototype.hasOwnProperty.call(d, 0x0001)) out.heartbeat_interval_s = d[0x0001];
        if (Object.prototype.hasOwnProperty.call(d, 0x0010)) out.uptime_s = d[0x0010];
        if (Object.prototype.hasOwnProperty.call(d, 0x0011)) out.route_table_fill_pct = d[0x0011];
        if (Object.prototype.hasOwnProperty.call(d, 0x0012)) out.neighbor_count = d[0x0012];
        if (Object.prototype.hasOwnProperty.call(d, 0x0013)) out.buffer_free_bytes = d[0x0013];
        if (Object.prototype.hasOwnProperty.call(d, 0x0014)) out.last_incoming_src = d[0x0014];
        return out;
    },
};

const tzDebugBits = {
    key: Object.keys(DBG_BITS).map(k => `debug_${k}`),
    convertSet: async (entity, key, value, meta) => {
        const bit = DBG_BITS[key.replace(/^debug_/, '')];
        const cur = (await entity.read(CLUSTER, [0x0000], { manufacturerCode: MFG }))[0x0000] || 0;
        const next = value ? (cur | bit) : (cur & ~bit);
        await entity.write(CLUSTER, { 0x0000: { value: next, type: Zcl.DataType.bitmap16 } },
            { manufacturerCode: MFG });
        const result = {};
        for (const [k, b] of Object.entries(DBG_BITS)) {
            result[`debug_${k}`] = (next & b) !== 0;
        }
        return { state: result };
    },
    convertGet: async (entity, key, meta) => {
        await entity.read(CLUSTER, [0x0000], { manufacturerCode: MFG });
    },
};

const tzHeartbeat = {
    key: ['heartbeat_interval_s'],
    convertSet: async (entity, key, value, meta) => {
        const v = Math.max(0, Math.min(3600, parseInt(value, 10)));
        await entity.write(CLUSTER, { 0x0001: { value: v, type: Zcl.DataType.uint16 } },
            { manufacturerCode: MFG });
        return { state: { heartbeat_interval_s: v } };
    },
    convertGet: async (entity, key, meta) => {
        await entity.read(CLUSTER, [0x0001], { manufacturerCode: MFG });
    },
};

const tzRO = {
    key: ['uptime_s', 'route_table_fill_pct', 'neighbor_count',
        'buffer_free_bytes', 'last_incoming_src'],
    convertGet: async (entity, key, meta) => {
        const map = {
            uptime_s: 0x0010, route_table_fill_pct: 0x0011,
            neighbor_count: 0x0012, buffer_free_bytes: 0x0013,
            last_incoming_src: 0x0014,
        };
        await entity.read(CLUSTER, [map[key]], { manufacturerCode: MFG });
    },
};

module.exports = [{
    zigbeeModel: [],
    fingerprint: [{
        modelID: undefined,
        endpoints: [{ ID: 1, inputClusters: [CLUSTER] }],
    }],
    model: 'SLZB-06MU-dense-router',
    vendor: 'AlexMKX',
    description: 'zigbee-dense optimized router firmware for SLZB-06MU',
    fromZigbee: [fzDebug],
    toZigbee: [tzDebugBits, tzHeartbeat, tzRO],
    exposes: [
        exposes.binary('debug_stack',     ea.ALL, true, false),
        exposes.binary('debug_core',      ea.ALL, true, false),
        exposes.binary('debug_app',       ea.ALL, true, false),
        exposes.binary('debug_zcl',       ea.ALL, true, false),
        exposes.binary('debug_route',     ea.ALL, true, false),
        exposes.binary('debug_aps_in',    ea.ALL, true, false),
        exposes.binary('debug_heartbeat', ea.ALL, true, false),
        exposes.numeric('heartbeat_interval_s', ea.ALL)
            .withValueMin(0).withValueMax(3600).withUnit('s'),
        exposes.numeric('uptime_s',             ea.STATE_GET).withUnit('s'),
        exposes.numeric('route_table_fill_pct', ea.STATE_GET).withUnit('%'),
        exposes.numeric('neighbor_count',       ea.STATE_GET),
        exposes.numeric('buffer_free_bytes',    ea.STATE_GET),
        exposes.numeric('last_incoming_src',    ea.STATE_GET),
    ],
    configure: async (device, coordinatorEndpoint, logger) => {
        const ep = device.getEndpoint(1);
        await ep.read(CLUSTER, [0x0000, 0x0001, 0x0010, 0x0011, 0x0012, 0x0013, 0x0014],
            { manufacturerCode: MFG });
    },
}];
