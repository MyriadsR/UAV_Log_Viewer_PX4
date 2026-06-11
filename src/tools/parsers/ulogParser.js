const textDecoder = new TextDecoder('utf-8')

const typeInfo = {
    bool: { size: 1, getter: 'getUint8' },
    char: { size: 1, getter: 'getUint8' },
    int8_t: { size: 1, getter: 'getInt8' },
    uint8_t: { size: 1, getter: 'getUint8' },
    int16_t: { size: 2, getter: 'getInt16' },
    uint16_t: { size: 2, getter: 'getUint16' },
    int32_t: { size: 4, getter: 'getInt32' },
    uint32_t: { size: 4, getter: 'getUint32' },
    int64_t: { size: 8, getter: 'getBigInt64' },
    uint64_t: { size: 8, getter: 'getBigUint64' },
    float: { size: 4, getter: 'getFloat32' },
    double: { size: 8, getter: 'getFloat64' }
}

const numericTypes = new Set([
    'bool',
    'int8_t',
    'uint8_t',
    'int16_t',
    'uint16_t',
    'int32_t',
    'uint32_t',
    'int64_t',
    'uint64_t',
    'float',
    'double'
])

function asArrayBuffer (data) {
    if (data instanceof ArrayBuffer) {
        return data
    }
    if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    }
    return data
}

function decodeString (view, offset, length) {
    let end = offset + length
    while (end > offset && view.getUint8(end - 1) === 0) {
        end -= 1
    }
    return textDecoder.decode(new Uint8Array(view.buffer, view.byteOffset + offset, end - offset))
}

function splitTypeAndName (definition) {
    const match = definition.trim().match(/^([a-zA-Z0-9_/-]+)(?:\[(\d+)])?\s+([a-zA-Z0-9_]+)$/)
    if (!match) {
        return null
    }
    return {
        type: match[1],
        arrayLength: match[2] ? parseInt(match[2]) : 1,
        name: match[3]
    }
}

function normalizeValue (value) {
    if (typeof value === 'bigint') {
        return Number(value)
    }
    return value
}

function quaternionToEuler (q0, q1, q2, q3) {
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

export class ULogParser {
    constructor () {
        this.messages = {}
        this.formats = {}
        this.subscriptions = {}
        this.params = {}
        this.defaultParams = {}
        this.loggedStrings = {
            time_boot_ms: [],
            severity: [],
            text: []
        }
        this.metadata = {}
        this.headerTimestamp = 0
        this.startTimestamp = null
        this.messageTypes = {}
    }

    static isULog (data) {
        const buffer = asArrayBuffer(data)
        if (!buffer || buffer.byteLength < 16) {
            return false
        }
        const bytes = new Uint8Array(buffer, 0, 7)
        return bytes[0] === 0x55 &&
            bytes[1] === 0x4c &&
            bytes[2] === 0x6f &&
            bytes[3] === 0x67 &&
            bytes[4] === 0x01 &&
            bytes[5] === 0x12 &&
            bytes[6] === 0x35
    }

    processData (data) {
        const buffer = asArrayBuffer(data)
        if (!ULogParser.isULog(buffer)) {
            throw new Error('Not a PX4 ULog file')
        }
        this.view = new DataView(buffer)
        this.headerTimestamp = normalizeValue(this.view.getBigUint64(8, true))
        this.parseMessages()
        this.addParameterMessages()
        if (this.loggedStrings.time_boot_ms.length > 0) {
            this.messages.ULOG_LOG = this.loggedStrings
        }
        this.messageTypes = this.buildMessageTypes()
        const metadata = {
            startTime: this.extractStartTime(),
            px4Info: this.metadata
        }
        self.postMessage({ metadata: metadata })
        self.postMessage({ messages: this.messages })
        self.postMessage({ availableMessages: this.messageTypes })
        self.postMessage({ percentage: 100 })
        self.postMessage({ messagesDoneLoading: true })
        return { types: this.messageTypes, messages: this.messages }
    }

    parseMessages () {
        let offset = 16
        const total = this.view.byteLength
        let lastPercentage = 0
        while (offset + 3 <= total) {
            const msgSize = this.view.getUint16(offset, true)
            const msgType = String.fromCharCode(this.view.getUint8(offset + 2))
            const payloadOffset = offset + 3
            const nextOffset = payloadOffset + msgSize
            if (nextOffset > total) {
                break
            }
            this.parseMessage(msgType, payloadOffset, msgSize)
            offset = nextOffset
            const percentage = Math.floor((offset / total) * 100)
            if (percentage >= lastPercentage + 5) {
                lastPercentage = percentage
                self.postMessage({ percentage: percentage })
            }
        }
    }

    parseMessage (type, offset, size) {
        if (type === 'F') {
            this.parseFormat(decodeString(this.view, offset, size))
        } else if (type === 'A') {
            this.parseSubscription(offset, size)
        } else if (type === 'D') {
            this.parseData(offset, size)
        } else if (type === 'I') {
            this.parseInfo(offset, size, this.metadata)
        } else if (type === 'M') {
            this.parseMultiInfo(offset, size)
        } else if (type === 'P') {
            this.parseInfo(offset, size, this.params)
        } else if (type === 'Q') {
            this.parseDefaultParameter(offset, size)
        } else if (type === 'L') {
            this.parseLoggedString(offset, size, 1, 9)
        } else if (type === 'C') {
            this.parseLoggedString(offset, size, 3, 11)
        }
    }

    parseFormat (format) {
        const separator = format.indexOf(':')
        if (separator === -1) {
            return
        }
        const name = format.slice(0, separator)
        const fieldDefs = format.slice(separator + 1).split(';').filter(Boolean)
        this.formats[name] = {
            name: name,
            fields: fieldDefs.map(splitTypeAndName).filter(Boolean),
            size: null,
            parsing: false
        }
    }

    parseSubscription (offset, size) {
        if (size < 3) {
            return
        }
        const multiId = this.view.getUint8(offset)
        const msgId = this.view.getUint16(offset + 1, true)
        const messageName = decodeString(this.view, offset + 3, size - 3)
        const key = multiId === 0 ? messageName : `${messageName}[${multiId}]`
        this.subscriptions[msgId] = {
            id: msgId,
            multiId: multiId,
            messageName: messageName,
            key: key
        }
        const format = this.formats[messageName]
        if (format) {
            this.ensureMessage(key, format)
        }
    }

    parseData (offset, size) {
        if (size < 2) {
            return
        }
        const msgId = this.view.getUint16(offset, true)
        const subscription = this.subscriptions[msgId]
        if (!subscription) {
            return
        }
        const format = this.formats[subscription.messageName]
        if (!format) {
            return
        }
        const message = this.parseFields(format, offset + 2, size - 2)
        if (!message) {
            return
        }
        this.appendMessage(subscription.key, format, message)
    }

    parseInfo (offset, size, target) {
        if (size < 1) {
            return
        }
        const keyLength = this.view.getUint8(offset)
        if (keyLength + 1 > size) {
            return
        }
        const keyDefinition = decodeString(this.view, offset + 1, keyLength)
        const field = splitTypeAndName(keyDefinition)
        if (!field) {
            return
        }
        target[field.name] = this.readValue(field, offset + 1 + keyLength, size - 1 - keyLength)
    }

    parseMultiInfo (offset, size) {
        if (size < 2) {
            return
        }
        const keyLength = this.view.getUint8(offset + 1)
        if (keyLength + 2 > size) {
            return
        }
        const keyDefinition = decodeString(this.view, offset + 2, keyLength)
        const field = splitTypeAndName(keyDefinition)
        if (!field) {
            return
        }
        const value = this.readValue(field, offset + 2 + keyLength, size - 2 - keyLength)
        if (!this.metadata[field.name]) {
            this.metadata[field.name] = []
        }
        this.metadata[field.name].push(value)
    }

    parseDefaultParameter (offset, size) {
        if (size < 2) {
            return
        }
        this.parseInfo(offset + 1, size - 1, this.defaultParams)
    }

    parseLoggedString (offset, size, timestampOffset, messageOffset) {
        if (size < messageOffset) {
            return
        }
        const level = this.view.getUint8(offset)
        const timestamp = normalizeValue(this.view.getBigUint64(offset + timestampOffset, true))
        const message = decodeString(this.view, offset + messageOffset, size - messageOffset)
        this.loggedStrings.time_boot_ms.push(this.toBootMilliseconds(timestamp))
        this.loggedStrings.severity.push(level)
        this.loggedStrings.text.push(message)
    }

    readValue (field, offset, availableLength) {
        if (field.type === 'char') {
            return decodeString(this.view, offset, Math.min(field.arrayLength, availableLength))
        }
        const values = []
        const info = typeInfo[field.type]
        if (!info) {
            return null
        }
        const count = Math.min(field.arrayLength, Math.floor(availableLength / info.size))
        for (let i = 0; i < count; i++) {
            values.push(normalizeValue(this.view[info.getter](offset + i * info.size, true)))
        }
        if (field.arrayLength === 1) {
            return values[0]
        }
        return values
    }

    parseFields (format, offset, availableLength) {
        const message = {}
        let cursor = offset
        const end = offset + availableLength
        for (const field of format.fields) {
            if (field.name.startsWith('_padding')) {
                const paddingSize = this.fieldSize(field)
                cursor = Math.min(cursor + paddingSize, end)
                continue
            }
            const fieldLength = this.fieldSize(field)
            if (cursor >= end) {
                break
            }
            const value = this.readFieldValue(field, cursor, end - cursor)
            cursor += fieldLength
            if (value === undefined) {
                continue
            }
            message[field.name] = value
            if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'number') {
                for (let i = 0; i < value.length; i++) {
                    message[`${field.name}[${i}]`] = value[i]
                }
            }
        }
        if (message.timestamp !== undefined) {
            if (this.startTimestamp === null) {
                this.startTimestamp = message.timestamp
            }
            message.time_boot_ms = this.toBootMilliseconds(message.timestamp)
        }
        return message
    }

    readFieldValue (field, offset, availableLength) {
        if (typeInfo[field.type]) {
            return this.readValue(field, offset, availableLength)
        }
        const nestedFormat = this.formats[field.type]
        if (!nestedFormat) {
            return undefined
        }
        const values = []
        const nestedSize = this.formatSize(nestedFormat)
        for (let i = 0; i < field.arrayLength; i++) {
            if (availableLength < (i + 1) * nestedSize) {
                break
            }
            values.push(this.parseFields(nestedFormat, offset + i * nestedSize, nestedSize))
        }
        return field.arrayLength === 1 ? values[0] : values
    }

    fieldSize (field) {
        if (typeInfo[field.type]) {
            return typeInfo[field.type].size * field.arrayLength
        }
        const nestedFormat = this.formats[field.type]
        return nestedFormat ? this.formatSize(nestedFormat) * field.arrayLength : 0
    }

    formatSize (format) {
        if (format.size !== null) {
            return format.size
        }
        if (format.parsing) {
            return 0
        }
        format.parsing = true
        format.size = format.fields.reduce((sum, field) => sum + this.fieldSize(field), 0)
        format.parsing = false
        return format.size
    }

    ensureMessage (key, format) {
        if (this.messages[key]) {
            return
        }
        const fields = this.extractNumericFields(format)
        const message = { time_boot_ms: [] }
        for (const field of fields) {
            message[field] = []
        }
        this.messages[key] = message
    }

    appendMessage (key, format, message) {
        this.addDerivedFields(key, message)
        this.ensureMessage(key, format)
        const target = this.messages[key]
        const fields = new Set(Object.keys(target))
        for (const field of Object.keys(message)) {
            if (!fields.has(field) && this.isPlottableValue(message[field])) {
                target[field] = []
                fields.add(field)
            }
        }
        for (const field of Object.keys(target)) {
            target[field].push(message[field])
        }
    }

    addDerivedFields (key, message) {
        if (!key.startsWith('vehicle_attitude')) {
            return
        }
        const hasQuaternion = message['q[0]'] !== undefined &&
            message['q[1]'] !== undefined &&
            message['q[2]'] !== undefined &&
            message['q[3]'] !== undefined
        if (!hasQuaternion || message.roll !== undefined) {
            return
        }
        const euler = quaternionToEuler(message['q[0]'], message['q[1]'], message['q[2]'], message['q[3]'])
        message.roll = euler[0]
        message.pitch = euler[1]
        message.yaw = euler[2]
    }

    extractNumericFields (format, prefix = '') {
        const fields = []
        for (const field of format.fields) {
            if (field.name.startsWith('_padding') || field.name === 'timestamp') {
                continue
            }
            const name = prefix ? `${prefix}.${field.name}` : field.name
            if (numericTypes.has(field.type)) {
                if (field.arrayLength === 1) {
                    fields.push(name)
                } else {
                    for (let i = 0; i < field.arrayLength; i++) {
                        fields.push(`${name}[${i}]`)
                    }
                }
            }
        }
        return fields
    }

    isPlottableValue (value) {
        return typeof value === 'number' || typeof value === 'boolean'
    }

    buildMessageTypes () {
        const messageTypes = {}
        for (const key of Object.keys(this.messages)) {
            const message = this.messages[key]
            const fields = Object.keys(message)
                .filter(field => field !== 'time_boot_ms' && message[field].some(this.isPlottableValue))
            const complexFields = {}
            for (const field of fields) {
                complexFields[field] = {
                    name: field,
                    units: '?',
                    multiplier: 1
                }
            }
            messageTypes[key] = {
                expressions: fields,
                units: null,
                multipiers: null,
                complexFields: complexFields
            }
        }
        return messageTypes
    }

    toBootMilliseconds (timestamp) {
        if (this.startTimestamp === null) {
            return Math.round(timestamp / 1000)
        }
        return Math.round((timestamp - this.startTimestamp) / 1000)
    }

    extractStartTime () {
        if (this.headerTimestamp > 0) {
            return new Date(this.headerTimestamp / 1000)
        }
        if (this.metadata && this.metadata.time_ref_utc) {
            return new Date(this.metadata.time_ref_utc * 1000)
        }
        return undefined
    }

    addParameterMessages () {
        const paramNames = Object.keys(this.params)
        if (paramNames.length > 0) {
            this.messages._PX4_PARAMS = {
                time_boot_ms: [],
                Name: [],
                Value: []
            }
            for (const name of paramNames) {
                this.messages._PX4_PARAMS.time_boot_ms.push(0)
                this.messages._PX4_PARAMS.Name.push(name)
                this.messages._PX4_PARAMS.Value.push(this.params[name])
            }
        }
        const defaultParamNames = Object.keys(this.defaultParams)
        if (defaultParamNames.length > 0) {
            this.messages._PX4_DEFAULT_PARAMS = {
                time_boot_ms: [],
                Name: [],
                Value: []
            }
            for (const name of defaultParamNames) {
                this.messages._PX4_DEFAULT_PARAMS.time_boot_ms.push(0)
                this.messages._PX4_DEFAULT_PARAMS.Name.push(name)
                this.messages._PX4_DEFAULT_PARAMS.Value.push(this.defaultParams[name])
            }
        }
    }

    loadType (_type) {
        self.postMessage({ messages: this.messages })
    }

    trimFile (_time) {
        console.warn('PX4 ULog trimming is not implemented')
    }
}

export default ULogParser
