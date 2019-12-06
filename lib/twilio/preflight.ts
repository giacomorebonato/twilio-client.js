/**
 * @module Voice
 * @preferred
 * @publicapi
 */
import { EventEmitter } from 'events';
import Connection from './connection';
import Device from './device';
import RTCSample from './rtc/sample';
import RTCWarning from './rtc/warning';

/**
 * A {@link PreflightTest} runs some tests to identify issues, if any, prohibiting successful calling.
 * @publicapi
 */
class PreflightTest extends EventEmitter {
  /**
   * Timeout id for when to end this test call
   */
  private _callTimeoutId: NodeJS.Timer;

  /**
   * The {@link Connection} for this test call
   */
  private _connection: Connection;

  /**
   * The {@link Device} for this test call
   */
  private _device: Device;

  /**
   * End of test timestamp
   */
  private _endTime: number | undefined;

  /**
   * Non-fatal errors detected during this test
   */
  private _errors: PreflightTest.NonFatalError[];

  /**
   * Latest WebRTC sample collected for this test
   */
  private _latestSample: RTCSample | undefined;

  /**
   * The options passed to {@link PreflightTest} constructor
   */
  private _options: PreflightTest.PreflightOptions = {
    callSeconds: 15,
    codecPreferences: [Connection.Codec.PCMU, Connection.Codec.Opus],
    connectParams: {},
  };

  /**
   * Results of this test
   */
  private _results: PreflightTest.TestResults | undefined;

  /**
   * WebRTC samples collected during this test
   */
  private _samples: RTCSample[];

  /**
   * Start of test timestamp
   */
  private _startTime: number;

  /**
   * Current status of this test
   */
  private _status: PreflightTest.TestStatus = PreflightTest.TestStatus.Connecting;

  /**
   * List of warning names and warning data detected during this test
   */
  private _warnings: PreflightTest.PreflightWarning[];

  /**
   * Construct a {@link PreflightTest} instance
   * @constructor
   * @param [token] - A Twilio JWT token string
   * @param [options]
   */
  constructor(token: string, options: PreflightTest.PreflightOptions) {
    super();

    Object.assign(this._options, options);

    this._errors = [];
    this._samples = [];
    this._warnings = [];
    this._startTime = Date.now();

    try {
      this._device = new (options.deviceFactory || Device)(token, {
        codecPreferences: this._options.codecPreferences,
        debug: true,
      });
    } catch {
      this._onFailed(PreflightTest.FatalError.UnsupportedBrowser);
    }

    this._device.on('ready', () => {
      this._onDeviceReady(this._options.connectParams);
    });

    this._device.on('error', (error: Device.Error) => {
      this._onDeviceError(error);
    });
  }

  /**
   * Cancels the current test and raises failed event
   */
  cancel(): void {
    this._device.once('offline', () => this._onFailed(PreflightTest.FatalError.CallCancelled));
    this._device.destroy();
  }

  /**
   * Get the average values of the WebRTC samples collected during the call
   */
  private _getAverageSample(): RTCSample | null {
    if (!this._latestSample) {
      return null;
    }

    const keys = Object.keys(this._latestSample)
      .filter((key) => this._latestSample && typeof this._latestSample[key] === 'number');

    // Get the totals for each key
    const sampleTotals = this._samples.reduce((totals: any, currentSample: RTCSample) => {
      keys.forEach((key: string) => {
        if (!totals[key]) {
          totals[key] = 0;
        }
        totals[key] += currentSample[key];
      });
      return totals;
    }, {});

    // Make a copy of a sample, along with the totals
    const sample = Object.assign({}, this._latestSample, sampleTotals);

    // Calculate the average
    keys.forEach((key: string) => {
      sample[key] = sample[key] / this._samples.length;
    });

    return sample;
  }

  /**
   * Returns the results of the test call
   */
  private _getResults(): PreflightTest.TestResults {
    return {
      averageSample: this._getAverageSample(),
      errors: this._errors,
      samples: this._samples,
      warnings: this._warnings,
    };
  }

  /**
   * Called when the test has been completed
   */
  private _onCompleted(): void {
    this._releaseHandlers();
    this._endTime = Date.now();
    this._status = PreflightTest.TestStatus.Completed;
    this._results = this._getResults();
    this.emit('completed', this._results);
  }

  /**
   * Called on {@link Device} error event
   * @param error
   */
  private _onDeviceError(error: Device.Error): void {
    let fatalError: PreflightTest.FatalError = PreflightTest.FatalError.UnknownError;
    switch (error.code) {
      case 31400:
        this._errors.push(PreflightTest.NonFatalError.InsightsConnectionFailed);
        this.emit('error', PreflightTest.NonFatalError.InsightsConnectionFailed);
        return;
      case 31000:
        fatalError = PreflightTest.FatalError.SignalingConnectionFailed;
        break;
      case 31003:
        fatalError = PreflightTest.FatalError.IceConnectionFailed;
        break;
      case 20101:
        fatalError = PreflightTest.FatalError.InvalidToken;
        break;
      case 31208:
        fatalError = PreflightTest.FatalError.MediaPermissionsFailed;
        break;
      case 31201:
        fatalError = PreflightTest.FatalError.NoDevicesFound;
        break;
    }
    this._device.destroy();
    this._onFailed(fatalError);
  }

  /**
   * Called on {@link Device} ready event
   * @param connectParams - Parameters that will be sent to your Twilio Application via {@link Device.connect}
   */
  private _onDeviceReady(connectParams: Record<string, string>): void {
    this._connection = this._device.connect(connectParams);
    this._setupConnectionHandlers(this._connection);

    this._callTimeoutId = setTimeout(() => {
      this._device.once('offline', () => this._onCompleted());
      this._device.destroy();
    }, (this._options.callSeconds! * 1000));
  }

  /**
   * Called when there is a fatal error
   * @param error
   */
  private _onFailed(error: PreflightTest.FatalError): void {
    clearInterval(this._callTimeoutId);
    this._releaseHandlers();
    this._endTime = Date.now();
    this._status = PreflightTest.TestStatus.Failed;
    this.emit('failed', error);
  }

  /**
   * Clean up all handlers for device and connection
   */
  private _releaseHandlers(): void {
    [this._device, this._connection].forEach((emitter: EventEmitter) => {
      emitter.eventNames().forEach((name: string) => emitter.removeAllListeners(name));
    });
  }

  /**
   * Setup the event handlers for the {@link Connection} of the test call
   * @param connection
   */
  private _setupConnectionHandlers(connection: Connection): void {
    connection.on('warning', (name: string, data: RTCWarning) => {
      this._warnings.push({ name, data });
      this.emit('warning', name, data);
    });

    connection.once('accept', () => {
      this._status = PreflightTest.TestStatus.Connected;
      this.emit(PreflightTest.TestStatus.Connected);
    });

    connection.on('sample', (sample) => {
      this._latestSample = sample;
      this._samples.push(sample);
      this.emit('sample', sample);
    });
  }

  /**
   * Return the end of the test timestamp
   */
  get endTime(): number | undefined {
    return this._endTime;
  }

  /**
   * Returns the latest WebRTC sample collected
   */
  get latestSample(): RTCSample | undefined {
    return this._latestSample;
  }

  /**
   * Returns the results of the test
   */
  get results(): PreflightTest.TestResults | undefined {
    return this._results;
  }

  /**
   * Return the start of the test timestamp
   */
  get startTime(): number {
    return this._startTime;
  }

  /**
   * Returns the status of the current test
   */
  get status(): PreflightTest.TestStatus {
    return this._status;
  }
}

namespace PreflightTest {
  /**
   * Possible fatal errors
   */
  export enum FatalError {
    CallCancelled = 'CallCancelled',
    IceConnectionFailed = 'IceConnectionFailed',
    InvalidToken = 'InvalidToken',
    MediaPermissionsFailed = 'MediaPermissionsFailed',
    NoDevicesFound = 'NoDevicesFound',
    SignalingConnectionFailed = 'SignalingConnectionFailed',
    UnknownError = 'UnknownError',
    UnsupportedBrowser = 'UnsupportedBrowser',
  }

  /**
   * Possible non fatal errors
   */
  export enum NonFatalError {
    InsightsConnectionFailed = 'InsightsConnectionFailed',
  }

  /**
   * Possible status of the test
   */
  export enum TestStatus {
    Connecting = 'connecting',
    Connected = 'connected',
    Completed = 'completed',
    Failed = 'failed',
  }

  /**
   * Options passed to {@link PreflightTest} constructor
   */
  export interface PreflightOptions {
    /**
     * Maximum duration of the test call
     */
    callSeconds?: number;

    /**
     * An ordered array of codec names that will be used during the test call,
     * from most to least preferred.
     */
    codecPreferences?: Connection.Codec[];

    /**
     * Parameters that will be sent to your Twilio Application via {@link Device.connect}
     */
    connectParams: Record<string, string>;

    /**
     * Device class to use
     */
    deviceFactory?: new (token: string, options: Device.Options) => Device;
  }

  /**
   * Represents the warning emitted from Voice SDK
   */
  export interface PreflightWarning {
    /**
     * Warning data associated with the warning
     */
    data: RTCWarning;

    /**
     * Name of the warning
     */
    name: string;
  }

  /**
   * Represents the results of the {@link PreflightTest}
   */
  export interface TestResults {
    /**
     * An RTCSample object containing average values of each RTC statistics
     */

    averageSample: RTCSample | null;

    /**
     * Non-fatal errors detected during the test
     */
    errors: PreflightTest.NonFatalError[];

    /**
     * WebRTC samples collected during the test
     */
    samples: RTCSample[];

    /**
     * List of warning names and warning data detected during this test
     */
    warnings: PreflightWarning[];
  }
 }

export default PreflightTest;