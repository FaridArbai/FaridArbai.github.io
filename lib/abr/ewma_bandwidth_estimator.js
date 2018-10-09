/* eslint-disable no-multiple-empty-lines */
/**
 * @license
 * Copyright 2016 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

goog.provide('shaka.abr.EwmaBandwidthEstimator');

goog.require('shaka.abr.Ewma');
goog.require('shaka.abr.HoltWright');


/**
 * Tracks bandwidth samples and estimates available bandwidth.
 * Based on the minimum of two exponentially-weighted moving averages with
 * different half-lives.
 *
 * @constructor
 * @struct
 */
shaka.abr.EwmaBandwidthEstimator = function() {
  /**
   * A fast-moving average.
   * Half of the estimate is based on the last 2 seconds of sample history.
   * @private {!shaka.abr.Ewma}
   */
    this.fast_ = new shaka.abr.Ewma(2);

  /**
   * A slow-moving average.
   * Half of the estimate is based on the last 5 seconds of sample history.
   * @private {!shaka.abr.Ewma}
   */
    this.slow_ = new shaka.abr.Ewma(5);

    this.algorithm = new shaka.abr.HoltWright();

  /**
   * Number of bytes sampled.
   * @private {number}
   */
    this.bytesSampled_ = 0;


  /**
   * Minimum number of bytes sampled before we trust the estimate.  If we have
   * not sampled much data, our estimate may not be accurate enough to trust.
   * If bytesSampled_ is less than minTotalBytes_, we use defaultEstimate_.
   * This specific value is based on experimentation.
   *
   * @private {number}
   * @const
   */
    this.minTotalBytes_ = 128e3;  // 128kB

  /**
   * Minimum number of bytes, under which samples are discarded.  Our models do
   * not include latency information, so connection startup time (time to first
   * byte) is considered part of the download time.  Because of this, we should
   * ignore very small downloads which would cause our estimate to be too low.
   * This specific value is based on experimentation.
   *
     * @private {number}
     * @const
     */
    this.minBytes_ = 16e3;  // 16kB

    this.v_obs = [];
    this.v_ewma = [];
    this.v_holt = [];

};


/**
 * Takes a bandwidth sample.
 *
 * @param {number} durationMs The amount of time, in milliseconds, for a
 *   particular request.
 * @param {number} numBytes The total number of bytes transferred in that
 *   request.
 */
shaka.abr.EwmaBandwidthEstimator.prototype.sample = function(
    durationMs, numBytes) {
  if (numBytes < this.minBytes_) {
    return;
  }

  let bandwidth = 8000 * numBytes / durationMs;
  let weight = durationMs / 1000;

  this.plot(bandwidth);

  this.bytesSampled_ += numBytes;
  this.fast_.sample(weight, bandwidth);
  this.slow_.sample(weight, bandwidth);
  this.algorithm.sample(weight, bandwidth);
};


/**
 * Gets the current bandwidth estimate.
 *
 * @param {number} defaultEstimate
 * @return {number} The bandwidth estimate in bits per second.
 */
shaka.abr.EwmaBandwidthEstimator.prototype.getBandwidthEstimate =
    function(defaultEstimate) {
  if (this.bytesSampled_ < this.minTotalBytes_) {
    return defaultEstimate;
  }

  // Take the minimum of these two estimates.  This should have the effect of
  // adapting down quickly, but up more slowly.
  return Math.min(this.fast_.getEstimate(), this.slow_.getEstimate());
};

shaka.abr.EwmaBandwidthEstimator.prototype.getHoltBandwidthEstimate =
    function(defaultEstimate) {
  if (this.bytesSampled_ < this.minTotalBytes_) {
    return defaultEstimate;
  }

  // Take the minimum of these two estimates.  This should have the effect of
  // adapting down quickly, but up more slowly.
  return this.algorithm.getBandwidthEstimate();
};


/**
 * @return {boolean} True if there is enough data to produce a meaningful
 *   estimate.
 */
shaka.abr.EwmaBandwidthEstimator.prototype.hasGoodEstimate = function() {
  return this.bytesSampled_ >= this.minTotalBytes_;
};

shaka.abr.EwmaBandwidthEstimator.prototype.plot = function(bandwidth){
    this.v_obs.push(bandwidth);
  this.v_ewma.push(this.getBandwidthEstimate(500000));
  this.v_holt.push(this.getHoltBandwidthEstimate(500000));

  var trace_obs = {
      y: this.v_obs,
      type: 'scatter',
      name: 'Observations',
      line: {
          width: 1,
          color: "#424242"
      },
  };

  var trace_ewma = {
      y: this.v_ewma,
      type: 'scatter',
      name: 'EWMA Pred.',
      line: {
          width: 3,
          color: "#e53835"
      },
  };

  var trace_holt = {
      y: this.v_holt,
      type: 'scatter',
      name: 'Holt Pred.',
      line: {
        width: 3,
        color: "#3f51b5"
      },
  };

  var prediction_layout = {
      title: 'Predicted Bandwidth',
      yaxis: {
        title: 'Bandwidth (bps)',
      },
      legend: {"orientation": "h"}
  };

  var prediction_traces = [trace_obs,trace_ewma, trace_holt];

  Plotly.newPlot('graph1', prediction_traces, prediction_layout);

  var max = Math.max(Math.max.apply(null, this.v_obs), Math.max.apply(null, this.v_ewma));
  var min = Math.min(Math.min.apply(null, this.v_obs), Math.min.apply(null, this.v_ewma));
  var sep_line = [min, max];

  var ewma_points = {
      x: this.v_obs,
      y: this.v_ewma,
      name: 'EWMA Scatter',
      mode: 'markers',
      style: 'scatter',
      line:{color: "#e53835"}
  };

  var holt_points = {
      x: this.v_obs,
      y: this.v_holt,
      name: 'Holt Scatter',
      mode: 'markers',
      style: 'scatter',
      line:{color: "#3f51b5"}
  };

  var trace_line = {
      x: sep_line,
      y: sep_line,
      name: 'Desired Zone',
      style: 'scatter',
      line:{color: "#424242"}
  };

  var scatter_layout = {
  title: 'Prediction Accuracy',
  yaxis: {
    title: 'Predicted Bandwidth (bps)',
  },
  legend: {"orientation": "h"}
  };

  var prediction_scatter = [trace_line, ewma_points, holt_points];

  Plotly.newPlot('graph2', prediction_scatter, scatter_layout);

}
