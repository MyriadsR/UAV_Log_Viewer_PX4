import { ParamSeeker } from '../tools/paramseeker'

const navStates = {
    0: 'Manual',
    1: 'Altitude',
    2: 'Position',
    3: 'Mission',
    4: 'Loiter',
    5: 'Return',
    6: 'RC Recover',
    7: 'Return',
    8: 'Land',
    9: 'Prec Land',
    10: 'Orbit',
    11: 'Takeoff',
    12: 'Acro',
    13: 'Descend',
    14: 'Terminate',
    15: 'Offboard',
    16: 'Stabilized',
    17: 'Rattitude',
    18: 'Auto Takeoff',
    19: 'Auto Land',
    20: 'Auto Follow',
    21: 'Auto Precland',
    22: 'VTOL Takeoff',
    23: 'External'
}

const armingStates = {
    1: 'Disarmed',
    2: 'Armed'
}

const syntheticReference = {
    lat: 47.397742,
    lon: 8.545594,
    alt: 0
}

const preferredTrajectorySources = [
    'vehicle_global_position',
    'vehicle_gps_position',
    'sensor_gps',
    'vehicle_local_position',
    'vehicle_odometry',
    'vehicle_visual_odometry',
    'vehicle_mocap_odometry',
    'estimator_odometry',
    'vehicle_local_position_setpoint',
    'trajectory_setpoint',
    'estimator_aid_src_aux_global_position',
    'estimator_aid_src_gnss_pos'
]

const latFields = ['lat', 'latitude', 'latitude_deg']
const lonFields = ['lon', 'lng', 'longitude', 'longitude_deg']
const altitudeFields = [
    'alt',
    'alt_ellipsoid',
    'altitude',
    'altitude_msl_m',
    'altitude_ellipsoid_m',
    'altitude_amsl_m',
    'height'
]
const localXFields = ['x', 'position[0]', 'local_position[0]']
const localYFields = ['y', 'position[1]', 'local_position[1]']
const localZFields = ['z', 'position[2]', 'local_position[2]']

function hasMessage (messages, name) {
    return name in messages && messages[name] && messages[name].time_boot_ms && messages[name].time_boot_ms.length > 0
}

function firstAvailable (messages, names) {
    return names.find(name => hasMessage(messages, name))
}

function fieldValue (message, fields, index) {
    for (const field of fields) {
        if (message[field] !== undefined && message[field][index] !== undefined) {
            return message[field][index]
        }
    }
    return undefined
}

function fieldEntry (message, fields, index) {
    for (const field of fields) {
        if (message[field] !== undefined && message[field][index] !== undefined) {
            return { field: field, value: message[field][index] }
        }
    }
    return null
}

function hasAnyField (message, fields) {
    return fields.some(field => Array.isArray(message[field]) && message[field].length > 0)
}

function normalizeCoordinateValue (entry) {
    if (!entry || !Number.isFinite(entry.value)) {
        return NaN
    }
    if (entry.field.endsWith('_rad')) {
        return entry.value * 180 / Math.PI
    }
    if (Math.abs(entry.value) > 180) {
        return entry.value * 1e-7
    }
    return entry.value
}

function normalizeLatLonEntries (latEntry, lonEntry, source) {
    if (!latEntry || !lonEntry) {
        return null
    }
    if (latEntry.field.startsWith('observation[') &&
        lonEntry.field.startsWith('observation[') &&
        source.includes('global_position') &&
        Math.abs(latEntry.value) <= Math.PI / 2 &&
        Math.abs(lonEntry.value) <= Math.PI) {
        return [
            latEntry.value * 180 / Math.PI,
            lonEntry.value * 180 / Math.PI
        ]
    }
    return [
        normalizeCoordinateValue(latEntry),
        normalizeCoordinateValue(lonEntry)
    ]
}

function normalizeAltitudeValue (entry) {
    if (!entry || !Number.isFinite(entry.value)) {
        return 0
    }
    if (entry.field.includes('_mm') || Math.abs(entry.value) > 100000) {
        return entry.value / 1000
    }
    return entry.value
}

function radiansFromQuaternion (q0, q1, q2, q3) {
    const sinrCosp = 2 * (q0 * q1 + q2 * q3)
    const cosrCosp = 1 - 2 * (q1 * q1 + q2 * q2)
    const roll = Math.atan2(sinrCosp, cosrCosp)

    const sinp = 2 * (q0 * q2 - q3 * q1)
    const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp)

    const sinyCosp = 2 * (q0 * q3 + q1 * q2)
    const cosyCosp = 1 - 2 * (q2 * q2 + q3 * q3)
    const yaw = Math.atan2(sinyCosp, cosyCosp)

    return [roll, pitch, yaw]
}

function localPositionToLatLon (refLat, refLon, north, east) {
    const earthRadius = 6378137
    const lat = refLat + (north / earthRadius) * 180 / Math.PI
    const lon = refLon + (east / (earthRadius * Math.cos(refLat * Math.PI / 180))) * 180 / Math.PI
    return [lat, lon]
}

function sourceHasGlobalFields (message, source) {
    return (hasAnyField(message, latFields) && hasAnyField(message, lonFields)) ||
        (source.includes('global_position') &&
            hasAnyField(message, ['observation[0]']) &&
            hasAnyField(message, ['observation[1]']))
}

function sourceHasLocalFields (message, source) {
    const looksLocal = /(local_position|odometry|trajectory_setpoint|visual_odometry|mocap_odometry)/.test(source)
    return looksLocal &&
        hasAnyField(message, localXFields) &&
        hasAnyField(message, localYFields)
}

function firstValidGlobalReference (messages) {
    for (const source of ['vehicle_global_position', 'vehicle_gps_position', 'sensor_gps', 'home_position']) {
        if (!hasMessage(messages, source)) {
            continue
        }
        const message = messages[source]
        for (const i in message.time_boot_ms) {
            const global = extractGlobalPosition(message, source, i)
            if (global && isFinitePoint(global.latLon, global.altMeters, message.time_boot_ms[i])) {
                return {
                    lat: global.latLon[0],
                    lon: global.latLon[1],
                    alt: global.altMeters
                }
            }
        }
    }
    return syntheticReference
}

function extractReferenceFromLocalMessage (message, index) {
    const latEntry = fieldEntry(message, ['ref_lat'], index)
    const lonEntry = fieldEntry(message, ['ref_lon'], index)
    const latLon = normalizeLatLonEntries(latEntry, lonEntry, 'vehicle_local_position')
    const altEntry = fieldEntry(message, ['ref_alt'], index)
    if (latLon &&
        Number.isFinite(latLon[0]) &&
        Number.isFinite(latLon[1]) &&
        latLon[0] !== 0 &&
        latLon[1] !== 0) {
        return {
            lat: latLon[0],
            lon: latLon[1],
            alt: normalizeAltitudeValue(altEntry)
        }
    }
    return null
}

function extractGlobalPosition (message, source, index) {
    let latEntry = fieldEntry(message, latFields, index)
    let lonEntry = fieldEntry(message, lonFields, index)
    if ((!latEntry || !lonEntry) && source.includes('global_position')) {
        latEntry = fieldEntry(message, ['observation[0]'], index)
        lonEntry = fieldEntry(message, ['observation[1]'], index)
    }
    const latLon = normalizeLatLonEntries(latEntry, lonEntry, source)
    const altEntry = fieldEntry(
        message,
        source.includes('global_position')
            ? [...altitudeFields, 'observation[2]']
            : altitudeFields,
        index
    )
    return {
        latLon: latLon,
        altMeters: normalizeAltitudeValue(altEntry)
    }
}

function extractLocalPosition (message, index, fallbackReference) {
    const north = fieldValue(message, localXFields, index)
    const east = fieldValue(message, localYFields, index)
    const down = fieldValue(message, localZFields, index) || 0
    if (!Number.isFinite(north) || !Number.isFinite(east) || !Number.isFinite(down)) {
        return null
    }
    const reference = extractReferenceFromLocalMessage(message, index) || fallbackReference || syntheticReference
    return {
        latLon: localPositionToLatLon(reference.lat, reference.lon, north, east),
        altMeters: reference.alt - down
    }
}

function isFinitePoint (latLon, altitude, time) {
    return latLon !== null &&
        Number.isFinite(latLon[0]) &&
        Number.isFinite(latLon[1]) &&
        Number.isFinite(altitude) &&
        Number.isFinite(time) &&
        latLon[0] !== 0 &&
        latLon[1] !== 0 &&
        Math.abs(latLon[0]) <= 90 &&
        Math.abs(latLon[1]) <= 180
}

export class Px4DataExtractor {
    static extractAttitude (messages, source) {
        const attitudes = {}
        if (!hasMessage(messages, source)) {
            return attitudes
        }
        const attitudeMsgs = messages[source]
        for (const i in attitudeMsgs.time_boot_ms) {
            const roll = fieldValue(attitudeMsgs, ['roll', 'phi'], i)
            const pitch = fieldValue(attitudeMsgs, ['pitch', 'theta'], i)
            const yaw = fieldValue(attitudeMsgs, ['yaw', 'psi', 'heading'], i)
            if (roll !== undefined && pitch !== undefined && yaw !== undefined) {
                attitudes[parseInt(attitudeMsgs.time_boot_ms[i])] = [roll, pitch, yaw]
                continue
            }
            const q0 = fieldValue(attitudeMsgs, ['q[0]'], i)
            const q1 = fieldValue(attitudeMsgs, ['q[1]'], i)
            const q2 = fieldValue(attitudeMsgs, ['q[2]'], i)
            const q3 = fieldValue(attitudeMsgs, ['q[3]'], i)
            if (q0 !== undefined && q1 !== undefined && q2 !== undefined && q3 !== undefined) {
                attitudes[parseInt(attitudeMsgs.time_boot_ms[i])] = radiansFromQuaternion(q0, q1, q2, q3)
            }
        }
        return attitudes
    }

    static extractAttitudeQ (messages, source) {
        const attitudes = {}
        if (!hasMessage(messages, source)) {
            return attitudes
        }
        const attitudeMsgs = messages[source]
        for (const i in attitudeMsgs.time_boot_ms) {
            const q0 = fieldValue(attitudeMsgs, ['q[0]'], i)
            const q1 = fieldValue(attitudeMsgs, ['q[1]'], i)
            const q2 = fieldValue(attitudeMsgs, ['q[2]'], i)
            const q3 = fieldValue(attitudeMsgs, ['q[3]'], i)
            if (q0 !== undefined && q1 !== undefined && q2 !== undefined && q3 !== undefined) {
                attitudes[parseInt(attitudeMsgs.time_boot_ms[i])] = [q0, q1, q2, q3]
            }
        }
        return attitudes
    }

    static extractAttitudeSources (messages) {
        const result = {
            quaternions: [],
            eulers: []
        }
        for (const source of ['vehicle_attitude', 'vehicle_attitude[1]']) {
            if (hasMessage(messages, source)) {
                result.quaternions.push(source)
            }
        }
        for (const source of ['vehicle_attitude_setpoint', 'vehicle_rates_setpoint']) {
            if (hasMessage(messages, source)) {
                result.eulers.push(source)
            }
        }
        return result
    }

    static extractFlightModes (messages) {
        const source = firstAvailable(messages, ['vehicle_status'])
        if (!source) {
            return []
        }
        const msgs = messages[source]
        const modes = []
        for (const i in msgs.time_boot_ms) {
            const navState = fieldValue(msgs, ['nav_state'], i)
            const mode = navStates[navState] || `NAV ${navState}`
            if (mode !== modes[modes.length - 1]?.[1]) {
                modes.push([msgs.time_boot_ms[i], mode])
            }
        }
        return modes
    }

    static extractEvents (messages) {
        const events = []
        const source = firstAvailable(messages, ['vehicle_status'])
        if (source) {
            const msgs = messages[source]
            for (const i in msgs.time_boot_ms) {
                const state = fieldValue(msgs, ['arming_state'], i)
                const event = armingStates[state] || `Arming ${state}`
                if (event !== events[events.length - 1]?.[1]) {
                    events.push([msgs.time_boot_ms[i], event])
                }
            }
        }
        if (hasMessage(messages, 'ULOG_LOG')) {
            const logs = messages.ULOG_LOG
            for (const i in logs.time_boot_ms) {
                events.push([logs.time_boot_ms[i], logs.text[i]])
            }
        }
        return events.sort((a, b) => a[0] - b[0])
    }

    static extractMission (_messages) {
        return []
    }

    static extractFences (_messages) {
        return []
    }

    static extractVehicleType (messages) {
        const source = firstAvailable(messages, ['vehicle_status'])
        if (!source) {
            return 'quadcopter'
        }
        const msgs = messages[source]
        const vehicleType = fieldValue(msgs, ['vehicle_type'], 0)
        if (vehicleType === 2) {
            return 'airplane'
        }
        if (vehicleType === 4) {
            return 'boat'
        }
        return 'quadcopter'
    }

    static extractDefaultParams (messages) {
        if (!messages._PX4_DEFAULT_PARAMS) {
            return {}
        }
        const params = {}
        const msg = messages._PX4_DEFAULT_PARAMS
        for (const i in msg.Name) {
            params[msg.Name[i]] = msg.Value[i]
        }
        return params
    }

    static extractParams (messages) {
        const params = []
        if (messages._PX4_PARAMS) {
            const paramData = messages._PX4_PARAMS
            for (const i in paramData.time_boot_ms) {
                params.push([
                    paramData.time_boot_ms[i],
                    paramData.Name[i],
                    paramData.Value[i]
                ])
            }
        }
        if (params.length > 0) {
            return new ParamSeeker(params)
        }
        return undefined
    }

    static extractTextMessages (messages) {
        const texts = []
        if (hasMessage(messages, 'ULOG_LOG')) {
            const textMsgs = messages.ULOG_LOG
            for (const i in textMsgs.time_boot_ms) {
                texts.push([textMsgs.time_boot_ms[i], textMsgs.severity[i], textMsgs.text[i]])
            }
        }
        return texts
    }

    static extractTrajectorySources (messages) {
        const candidates = []
        for (const source of preferredTrajectorySources) {
            if (hasMessage(messages, source)) {
                candidates.push(source)
            }
        }
        for (const source of Object.keys(messages).sort()) {
            if (candidates.includes(source) || !hasMessage(messages, source)) {
                continue
            }
            const message = messages[source]
            if (sourceHasGlobalFields(message, source) || sourceHasLocalFields(message, source)) {
                candidates.push(source)
            }
        }
        return candidates
    }

    static extractTrajectory (messages, source) {
        const ret = {}
        if (!hasMessage(messages, source)) {
            return ret
        }
        const gpsData = messages[source]
        const trajectory = []
        const timeTrajectory = {}
        let startAltitude = null
        const fallbackReference = firstValidGlobalReference(messages)
        const isLocalSource = sourceHasLocalFields(gpsData, source)
        for (const i in gpsData.time_boot_ms) {
            const extracted = isLocalSource
                ? extractLocalPosition(gpsData, i, fallbackReference)
                : extractGlobalPosition(gpsData, source, i)
            if (!extracted) {
                continue
            }
            const latLon = extracted.latLon
            const altMeters = extracted.altMeters
            const time = gpsData.time_boot_ms[i]
            if (!isFinitePoint(latLon, altMeters, time)) {
                continue
            }
            if (startAltitude === null) {
                startAltitude = altMeters
            }
            const relativeAltitude = altMeters - startAltitude
            trajectory.push([
                latLon[1],
                latLon[0],
                relativeAltitude,
                time
            ])
            timeTrajectory[time] = [
                latLon[1],
                latLon[0],
                relativeAltitude,
                time
            ]
        }
        if (trajectory.length) {
            ret[source] = {
                startAltitude: startAltitude,
                trajectory: trajectory,
                timeTrajectory: timeTrajectory
            }
        }
        return ret
    }

    static diagnoseTrajectorySources (messages) {
        const sources = this.extractTrajectorySources(messages)
        if (sources.length === 0) {
            const positionLikeTopics = Object.keys(messages)
                .filter(name => hasMessage(messages, name) && /(gps|global|local|position|odometry)/.test(name))
                .sort()
                .slice(0, 20)
                .map(name => {
                    const message = messages[name]
                    const fields = Object.keys(message)
                        .filter(field => field !== 'time_boot_ms')
                        .slice(0, 10)
                        .join(', ')
                    return `${name}(${message.time_boot_ms.length}): ${fields}`
                })
            return 'No trajectory candidate source found.\n' +
                (positionLikeTopics.length > 0
                    ? `Position-like topics:\n${positionLikeTopics.join('\n')}`
                    : 'No position-like topics were logged.')
        }
        const diagnostics = [`Trajectory candidates: ${sources.join(', ')}`]
        for (const source of sources) {
            const message = messages[source]
            const extracted = this.extractTrajectory(messages, source)
            const count = extracted[source]?.trajectory.length || 0
            const fields = Object.keys(message)
                .filter(field => field !== 'time_boot_ms')
                .slice(0, 14)
                .join(', ')
            diagnostics.push(`${source}: ${count}/${message.time_boot_ms.length} valid points; fields=${fields}`)
        }
        return diagnostics.join('\n')
    }

    static extractNamedValueFloatNames (_messages) {
        return []
    }

    static extractStartTime (_messages) {
        return undefined
    }
}
