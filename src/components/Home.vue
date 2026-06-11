<template>
    <div id='vuewrapper' style="height: 100%;">
        <template v-if="(state.mapLoading && !state.mapError) || state.plotLoading">
            <div id="waiting">
                <atom-spinner
                    :animation-duration="1000"
                    :color="'#64e9ff'"
                    :size="300"
                />
            </div>
        </template>
        <TxInputs fixed-aspect-ratio v-if="state.mapAvailable && state.showMap && state.showRadio"></TxInputs>
        <ParamViewer    @close="state.showParams = false" v-if="state.showParams"></ParamViewer>
        <MessageViewer  @close="state.showMessages = false" v-if="state.showMessages"></MessageViewer>
        <DeviceIDViewer @close="state.showDeviceIDs = false" v-if="state.showDeviceIDs"></DeviceIDViewer>
        <AttitudeViewer @close="state.showAttitude = false" v-if="state.showAttitude"></AttitudeViewer>
        <MagFitTool     @close="state.showMagfit = false" v-if="state.showMagfit"></MagFitTool>
        <EkfHelperTool  @close="state.showEkfHelper = false" v-if="state.showEkfHelper"></EkfHelperTool>
        <div class="container-fluid" style="height: 100%; overflow: hidden;">

            <sidebar/>

            <main class="col-md-9 ml-sm-auto col-lg-10 flex-column d-sm-flex" role="main">

                <div class="row"
                     v-bind:class="[state.showMap ? 'h-50' : 'h-100']"
                     v-if="state.plotOn">
                    <div class="col-12">
                        <Plotly/>
                    </div>
                </div>
                <div class="row" v-bind:class="[state.plotOn ? 'h-50' : 'h-100']"
                     v-if="state.showMap">
                    <div class="col-12 noPadding">
                        <CesiumViewer v-if="state.mapAvailable && mapOk && !state.mapError" ref="cesiumViewer"/>
                        <button
                            v-if="state.mapDebug"
                            type="button"
                            class="map-debug-toggle"
                            :title="showMapDebug ? 'Hide map debug info' : 'Show map debug info'"
                            @click="showMapDebug = !showMapDebug">
                            <i class="fas fa-terminal"></i>
                        </button>
                        <pre v-if="state.mapDebug && showMapDebug" class="map-debug-panel">{{ state.mapDebug }}</pre>
                        <div v-if="state.mapError" class="map-error-container">
                            <i class="fas fa-exclamation-triangle"></i>
                            <h3>Map Initialization Failed</h3>
                            <p>{{ state.mapError }}</p>
                            <button
                                type="button"
                                @click.stop.prevent="dismissMapError"
                                class="btn btn-outline-info btn-sm">Dismiss</button>
                        </div>
                        <div v-else-if="!(state.mapAvailable && mapOk)" class="map-error-container">
                             <i class="fas fa-map-marked-alt"></i>
                             <h3>No Map Data</h3>
                             <p>This log file does not contain enough GPS or trajectory data to display on the map.</p>
                             <button
                                 @click="state.showMap = false"
                                 class="btn btn-outline-info btn-sm">Close Map</button>
                        </div>
                    </div>
                </div>
            </main>

        </div>
    </div>
</template>

<script>
import isOnline from 'is-online'
import Plotly from '@/components/Plotly.vue'
import CesiumViewer from '@/components/CesiumViewer.vue'
import Sidebar from '@/components/Sidebar.vue'
import TxInputs from '@/components/widgets/TxInputs.vue'
import ParamViewer from '@/components/widgets/ParamViewer.vue'
import MessageViewer from '@/components/widgets/MessageViewer.vue'
import DeviceIDViewer from '@/components/widgets/DeviceIDViewer.vue'
import AttitudeViewer from '@/components/widgets/AttitudeWidget.vue'
import { store } from '@/components/Globals.js'
import { AtomSpinner } from 'epic-spinners'
import { Color } from 'cesium'
import colormap from 'colormap'
import { DataflashDataExtractor } from '../tools/dataflashDataExtractor'
import { MavlinkDataExtractor } from '../tools/mavlinkDataExtractor'
import { Px4DataExtractor } from '../tools/px4DataExtractor'
import { DjiDataExtractor } from '../tools/djiDataExtractor'
import MagFitTool from '@/components/widgets/MagFitTool.vue'
import EkfHelperTool from '@/components/widgets/EkfHelperTool.vue'
import Vue from 'vue'

export default {
    name: 'Home',
    created () {
        this.$eventHub.$on('messagesDoneLoading', this.extractFlightData)
        this.state.messages = {}
        this.state.timeAttitude = {}
        this.state.timeAttitudeQ = {}
        this.state.currentTrajectory = []
        isOnline().then(a => { this.state.isOnline = a })
    },
    beforeDestroy () {
        this.$eventHub.$off('messages')
    },
    data () {
        return {
            state: store,
            dataExtractor: null,
            showMapDebug: false
        }
    },
    methods: {
        dismissMapError () {
            this.state.mapError = null
            this.state.mapLoading = false
            this.state.showMap = false
            this.state.mapAvailable = false
        },
        resetDerivedFlightData () {
            this.dataExtractor = null
            this.state.flightModeChanges = []
            this.state.events = []
            this.state.mission = []
            this.state.fences = []
            this.state.textMessages = []
            this.state.namedFloats = []
            this.state.params = undefined
            this.state.defaultParams = {}
            this.state.vehicle = undefined
            this.state.attitudeSources = { quaternions: [], eulers: [] }
            this.state.attitudeSource = null
            this.state.timeAttitude = {}
            this.state.timeAttitudeQ = {}
            this.state.trajectorySources = []
            this.state.trajectorySource = ''
            this.state.trajectories = {}
            this.state.currentTrajectory = []
            this.state.timeTrajectory = {}
            this.state.timeRange = null
            this.state.mapAvailable = false
            this.state.mapError = null
            this.state.mapLoading = false
            this.state.mapDebug = ''
        },
        selectDataExtractor () {
            if (this.state.logType === 'tlog') {
                return MavlinkDataExtractor
            }
            if (this.state.logType === 'px4') {
                return Px4DataExtractor
            }
            if (this.state.logType === 'dji') {
                return DjiDataExtractor
            }
            return DataflashDataExtractor
        },
        extractFlightData () {
            this.resetDerivedFlightData()
            this.dataExtractor = this.selectDataExtractor()
            if ('FMTU' in this.state.messages && this.state.messages.FMTU.length === 0) {
                this.state.processStatus = 'ERROR PARSING?'
            }

            this.state.flightModeChanges = this.dataExtractor.extractFlightModes(this.state.messages)
            Vue.delete(this.state.messages, 'MODE')

            this.state.events = this.dataExtractor.extractEvents(this.state.messages)
            Vue.delete(this.state.messages, 'STAT')
            Vue.delete(this.state.messages, 'EV')

            this.state.mission = this.dataExtractor.extractMission(this.state.messages)

            Vue.delete(this.state.messages, 'CMD')

            this.state.vehicle = this.dataExtractor.extractVehicleType(this.state.messages)
            this.state.params = this.dataExtractor.extractParams(this.state.messages)
            if (this.state.params !== undefined) {
                this.state.defaultParams = this.dataExtractor.extractDefaultParams(this.state.messages)
                this.$eventHub.$on('cesium-time-changed', (time) => {
                    this.state.params.seek(time)
                })
            }
            if (this.state.vehicle === 'quadcopter') {
                if (this.state.params?.get('FRAME_TYPE') === 0) {
                    this.state.vehicle += '+'
                } else {
                    this.state.vehicle += 'x'
                }
            }
            this.state.textMessages = this.dataExtractor.extractTextMessages(this.state.messages)
            Vue.delete(this.state.messages, 'MSG')

            if (this.state.colors.length === 0) {
                this.generateColorMMap()
            }
            this.state.attitudeSources = this.dataExtractor.extractAttitudeSources(this.state.messages)
            if (this.state.attitudeSources.quaternions.length > 0) {
                const source = this.state.attitudeSources.quaternions[0]
                this.state.attitudeSource = source
                this.state.timeAttitudeQ = this.dataExtractor.extractAttitudeQ(this.state.messages, source)
            } else if (this.state.attitudeSources.eulers.length > 0) {
                const source = this.state.attitudeSources.eulers[0]
                this.state.attitudeSource = source
                this.state.timeAttitude = this.dataExtractor.extractAttitude(this.state.messages, source)
            }

            const attitudeTimes = Object.keys(this.state.timeAttitudeQ).length > 0
                ? this.state.timeAttitudeQ
                : this.state.timeAttitude
            const list = Object.keys(attitudeTimes)
            this.state.lastTime = list.length > 0 ? parseInt(list[list.length - 1]) : null

            this.state.trajectorySources = this.dataExtractor.extractTrajectorySources(this.state.messages)
            if (this.state.trajectorySources.length > 0) {
                for (const source of this.state.trajectorySources) {
                    const trajectories = this.dataExtractor.extractTrajectory(
                        this.state.messages,
                        source
                    )
                    if (trajectories[source] && trajectories[source].trajectory.length > 0) {
                        this.state.trajectorySource = source
                        this.state.trajectories = trajectories
                        this.state.currentTrajectory = trajectories[source].trajectory
                        this.state.timeTrajectory = trajectories[source].timeTrajectory
                        break
                    }
                }
                if (this.state.currentTrajectory.length === 0) {
                    console.log('unable to load trajectory from any source', this.state.trajectorySources)
                }
            }
            if (this.state.logType !== 'px4') {
                try {
                    if (this.state.messages?.GPS?.time_boot_ms) {
                        this.state.metadata = {
                            startTime: this.dataExtractor.extractStartTime(this.state.messages.GPS)
                        }
                    } else {
                        this.state.metadata = {
                            startTime: this.dataExtractor.extractStartTime(this.state.messages['GPS[0]'])
                        }
                    }
                } catch (error) {
                    console.log('unable to load metadata')
                    console.log(error)
                }
            }
            try {
                this.state.namedFloats = this.dataExtractor.extractNamedValueFloatNames(this.state.messages)
                console.log(this.state.namedFloats)
            } catch (error) {
                console.log('unable to load named floats')
                console.log(error)
            }
            Vue.delete(this.state.messages, 'AHR2')
            Vue.delete(this.state.messages, 'POS')
            Vue.delete(this.state.messages, 'GPS')

            this.state.fences = this.dataExtractor.extractFences(this.state.messages)

            this.state.processStatus = 'Processed!'
            this.state.processDone = true
            // Change to plot view after 2 seconds so the Processed status is readable
            setTimeout(() => { this.$eventHub.$emit('set-selected', 'plot') }, 2000)

            this.state.mapAvailable = this.state.currentTrajectory.length > 0
            this.state.showMap = true
            if (this.state.mapAvailable) {
                this.state.mapDebug = `PX4/map data ready: ${this.state.trajectorySource}, ` +
                    `${this.state.currentTrajectory.length} trajectory points`
            } else {
                this.state.mapDebug = this.dataExtractor.diagnoseTrajectorySources
                    ? this.dataExtractor.diagnoseTrajectorySources(this.state.messages)
                    : 'No usable trajectory source found in this log.'
            }
        },

        generateColorMMap () {
            const colorMapOptions = {
                colormap: 'hsv',
                nshades: Math.max(11, this.setOfModes.length),
                format: 'rgbaString',
                alpha: 1
            }
            // colormap used on legend.
            this.state.cssColors = colormap(colorMapOptions)

            // colormap used on Cesium
            colorMapOptions.format = 'float'
            this.state.colors = []
            // this.translucentColors = []
            for (const rgba of colormap(colorMapOptions)) {
                this.state.colors.push(new Color(rgba[0], rgba[1], rgba[2]))
                // this.translucentColors.push(new Cesium.Color(rgba[0], rgba[1], rgba[2], 0.1))
            }
        }
    },
    components: {
        Sidebar,
        Plotly,
        CesiumViewer,
        AtomSpinner,
        TxInputs,
        ParamViewer,
        MessageViewer,
        DeviceIDViewer,
        AttitudeViewer,
        MagFitTool,
        EkfHelperTool
    },
    computed: {
        mapOk () {
            return (this.state.currentTrajectory !== undefined &&
                    this.state.currentTrajectory.length > 0)
        },
        setOfModes () {
            const set = []
            if (!this.state.flightModeChanges) {
                return []
            }
            for (const mode of this.state.flightModeChanges) {
                if (!set.includes(mode[1])) {
                    set.push(mode[1])
                }
            }
            return set
        }
    }
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

    .nav-side-menu ul :not(collapsed) .arrow:before,
    .nav-side-menu li :not(collapsed) .arrow:before {
        font-family: 'Montserrat', sans-serif;
        content: "\f078";
        display: inline-block;
        padding-left: 10px;
        padding-right: 10px;
        vertical-align: middle;
        float: right;
    }

    body {
        margin: 0;
        padding: 0;
    }

    .container-fluid {
        padding-left: 0;
        padding-right: 0;
    }

    div .col-12 {
        padding-left: 0;
        padding-right: 0;
    }

    i {
        margin: 10px;
    }

    i .dropdown {
        float: right;
    }

    .noPadding {
        position: relative;
        padding-left: 4px;
        padding-right: 6px;
        max-height: 100%;
    }

    .map-debug-toggle {
        position: absolute;
        left: 14px;
        bottom: 14px;
        z-index: 1110;
        width: 34px;
        height: 34px;
        padding: 0;
        border: 1px solid rgba(100, 233, 255, 0.65);
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.66);
        color: #bff7ff;
        cursor: pointer;
    }

    .map-debug-toggle i {
        margin: 0;
        font-size: 13px;
    }

    .map-debug-panel {
        position: absolute;
        left: 14px;
        bottom: 54px;
        z-index: 1100;
        max-width: min(520px, calc(100% - 28px));
        max-height: 150px;
        margin: 0;
        padding: 8px 10px;
        border: 1px solid rgba(100, 233, 255, 0.55);
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.72);
        color: #bff7ff;
        font-family: monospace;
        font-size: 12px;
        line-height: 1.4;
        white-space: pre-wrap;
        overflow: hidden;
        pointer-events: none;
    }

    div #waiting {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 1000;
        display: block;
        background-color: black;
        opacity: 0.75;
        text-align: center;
    }

    .map-error-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        background-color: #1a1e24;
        color: #e0e6ed;
        text-align: center;
        padding: 2rem;
        border: 1px solid #3d4450;
        border-radius: 8px;
        margin: 10px;
    }

    .map-error-container i {
        font-size: 3rem;
        color: #ffcc00;
        margin-bottom: 1rem;
    }

    .map-error-container h3 {
        margin-bottom: 0.5rem;
        color: #64e9ff;
    }

    .map-error-container p {
        max-width: 500px;
        margin-bottom: 1.5rem;
        color: #acb6c2;
    }

    /* ATOM SPINNER */

      div .atom-spinner {
        margin: auto;
        margin-top: 15%;
    }

</style>
<style>
a {
    color: #ffffff !important;
}
</style>
