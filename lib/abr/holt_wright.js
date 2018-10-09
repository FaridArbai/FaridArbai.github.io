goog.provide('shaka.abr.HoltWright');
goog.require('goog.asserts');

shaka.abr.HoltWright = function(){
    this.alphaInit = 0.5;
    this.betaInit = 0.5;

    this.alpha_ = this.alphaInit;
    this.beta_ = this.betaInit;

    this.estimate_ = 0;

    this.smooth_ = 0;
    this.trend_ = 0;

    this.minEstimate = 500000;

    this.firstObservation = 0;
    this.sampleIndex = 0;
    this.previous_obs = 0;
}

shaka.abr.HoltWright.prototype.sample = function(tau, obs){
    this.updateParameters(tau);

    if(this.sampleIndex==0){
        this.firstObservation = obs;
        this.sampleIndex++;
        return;
    }
    else if(this.sampleIndex==1){
        this.previous_obs = obs;
        this.smooth_ = (obs + this.firstObservation)/2;
        this.trend_ = 0;

        var estimate_tmp = this.smooth_ + this.trend_*tau;

        if(estimate_tmp < this.minEstimate){
            this.estimate_ = this.minEstimate;
        }
        else{
            this.estimate_ = estimate_tmp;
        }

        this.sampleIndex++;
        return;
    }
    var actual_obs = obs;
    obs = (this.previous_obs + actual_obs)/2;
    this.previous_obs = actual_obs;

    let previousSmooth = this.smooth_;

    this.smooth_ = (1-this.alpha_)*this.estimate_ + this.alpha_*obs;

    let trendEstimate = (this.smooth_ - previousSmooth)/tau;

    this.trend_ = (1-this.beta_)*this.trend_ + this.beta_*trendEstimate;

    var estimate_tmp = this.smooth_ + this.trend_*tau;

    if(estimate_tmp < this.minEstimate){
        this.estimate_ = this.minEstimate;
    }
    else{
        this.estimate_ = estimate_tmp;
    }

    this.sampleIndex++;
}

shaka.abr.HoltWright.prototype.getBandwidthEstimate = function(){
    return this.estimate_;
}

shaka.abr.HoltWright.prototype.updateParameters = function(tau){
    this.updateAlpha(tau);
    this.updateBeta(tau);
}

shaka.abr.HoltWright.prototype.updateAlpha = function(tau){
    let correction = Math.pow((1-this.alphaInit),tau);

    this.alpha_ = this.alpha_/(this.alpha_ + correction);
}

shaka.abr.HoltWright.prototype.updateBeta = function(tau){
    let correction = Math.pow((1-this.betaInit),tau);

    this.beta_ = this.beta_/(this.beta_ + correction);
}

















































