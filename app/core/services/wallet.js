/* global _, angular, console, Decimal, StellarSdk */

angular.module('app')
.factory('Wallet', function ($http, $q, $rootScope, $timeout, $translate, $window, History, Horizon, Keychain, Storage) {
	'use strict';

	//------------------------------------------------------------------------------------------------------------------
	//	Account
	//------------------------------------------------------------------------------------------------------------------

	function _sortAssetCodes(a, b) {
		return (a.asset_code > b.asset_code) - (a.asset_code < b.asset_code);
	}

	function parseBalances(res) {
		var native = res.balances.filter(function (e) {
			return e.asset_type === 'native';
		});

		var credit_alphanum4 = res.balances.filter(function (e) {
			return e.asset_type === 'credit_alphanum4';
		});

		var credit_alphanum12 = res.balances.filter(function (e) {
			return e.asset_type === 'credit_alphanum12';
		});

		credit_alphanum4.sort(_sortAssetCodes);
		credit_alphanum12.sort(_sortAssetCodes);

		native[0].asset_code = 'XLM';
		return native.concat(credit_alphanum4, credit_alphanum12);
	}

	function Account(params) {

		this.getAccountInfo = function () {

			var self = this;

			return self.horizon().accounts()
			.accountId(self.id).call()
			.catch(function (err) {
				$timeout(self.refresh.bind(self), 60000);
				return $q.reject(err);
			})
			.then(function (res) {
				self.balances		= parseBalances(res);
				self.flags			= res.flags;
				self.inflationDest	= res.inflation_destination;
				self.sequence		= res.sequence;
				self.signers		= res.signers;
				self.subentryCount	= res.subentry_count;
				self.thresholds		= res.thresholds;

				Storage.setItem('account.' + self.alias, self);
			});
		};

		function extend(a, b) {
			for (var i in b) {
				if (b.hasOwnProperty(i)) {
					a[i] = b[i];
				}
			}
		}

		extend(this, params);
		this.refresh();
	}

	Account.prototype.horizon = function () {
		return Horizon.getServer(this.network);
	};

	Account.prototype.getNativeBalance = function () {
		return this.balances[0].balance;
	};

	Account.prototype.getReserve = function () {
		return 10 * (2 + this.subentryCount);
	};

	//	return true if account has enough balance to send 'amount' XLM in a tx w/ 'numOps' operations
	Account.prototype.canSend = function (amount, numOps) {
		return (10000000*(this.getNativeBalance() - this.getReserve() - amount) - 100*numOps) >= 0;
	};

	Account.prototype.refresh = function () {

		console.log('refreshing ' + this.alias);

		if (this.closeStream) {
			this.closeStream();
		}

		var self = this;
		return this.getAccountInfo()
		.then(
			function () {
				return History.getTransactions(self, 20)
				.then(function () {
					History.subscribe(self);
				});
			},
			function (err) {
				console.log(err);
			}
		);
	};

	//
	//	is it possible to sign a medium threshold tx with only unencrypted local keys?
	//

	Account.prototype.isLocallySecure = function () {

		var signers = this.signers
		.filter(function (signer) {
			return (signer.weight !== 0);
		})
		.filter(function (signer) {
			return Keychain.isLocalSigner(signer.public_key);
		})
		.filter(function (signer) {
			return !Keychain.isEncrypted(signer.public_key);
		});

		var weight = 0;
		signers.forEach(function (signer) {
			weight += signer.weight;
		});

		var threshold = this.thresholds.med_threshold;
		if (threshold === 0) {
			threshold = 1;
		}

		return (weight < threshold);
	};

	Account.prototype.isMultiSig = function () {

		if (!this.signers) {
			return false;
		}

		var signers = this.signers.filter(function (signer) {
			return (signer.weight !== 0);
		});

		return (signers.length !== 1);
	};

	function saveAccountList() {
		var accountNames = accountList.map(function (account) {
			return account.alias;
		});
		Storage.setItem('accounts', accountNames);
	}

	//------------------------------------------------------------------------------------------------------------------
	//	Wallet
	//------------------------------------------------------------------------------------------------------------------

	var accounts = {};
	var currentAccount;

	var Wallet = {
		accounts: accounts,
		get current () {
			return currentAccount;
		},
		set current (account) {
			currentAccount = account;
			Storage.setItem('currentAccount', account.alias);
		}
	};

	Wallet.createEmptyAccount = function (name, network) {

		var keys = StellarSdk.Keypair.random();
		var accountId = keys.accountId();
		var seed = keys.seed();

		return Wallet.importAccount(accountId, seed, name, network);
	};

	Wallet.importAccount = function (accountId, seed, name, network) {

		if (!network) {
			network = Horizon.livenet;
		}

		Keychain.addKey(accountId, seed);

		var opts = {
			id:			accountId,
			network:	network,
			alias:		name,
			balances: [{
				asset_type: 'native',
				asset_code: 'XLM',
				balance: '0'
			}]
		};

		var self = new Account(opts);
		accounts[self.id] = self;
		Storage.setItem('account.' + self.alias, self);

		accountList.push(self);
		saveAccountList();

		Wallet.current = self;
		return self;
	};

	Wallet.renameAccount = function (account, newName) {

		var oldName = account.alias;
		if (oldName === newName) {
			return;
		}

		History.effects[newName] = History.effects[oldName];
		account.alias = newName;
		delete History.effects[oldName];

		Storage.setItem('account.' + newName, account);
		Storage.setItem('history.' + newName, History.effects[newName]);
		saveAccountList();
		Storage.setItem('currentAccount', newName);
		Storage.removeItem('account.' + oldName);
		Storage.removeItem('history.' + oldName);
	};

	Wallet.removeAccount = function (account) {

		if (account.closeStream) {
			account.closeStream();
		}

		var index = accountList.indexOf(account);
		accountList.splice(index, 1);
		saveAccountList();

		var currentIndex = Math.max(0, index - 1);
		Wallet.current = accountList[currentIndex];
		Storage.setItem('currentAccount', Wallet.current.alias);

		delete accounts[account.id];
		Storage.removeItem('account.' + account.alias);
		Storage.removeItem('history.' + account.alias);
	};

	Wallet.moveAccount = function (account, fromIndex, toIndex) {
		accountList.splice(fromIndex, 1);
		accountList.splice(toIndex, 0, account);
		saveAccountList();
	};

	Wallet.getAssetCodeCollisions = function (assets) {
		var seen = {};
		var collisions = {};
		assets.forEach(function (asset) {
			if (asset.asset_type !== 'native') {
				var code = asset.asset_code;
				var issuer = asset.asset_issuer;
				if (code in seen) {
					if (!(issuer in seen[code])) {
						collisions[asset.asset_code] = 1;
					}
				} else {
					seen[code] = {};
				}
				seen[code][issuer] = 1;
			}
		});

		return collisions;
	};

	//------------------------------------------------------------------------------------------------------------------

	var accountList = Storage.getItem('accounts');
	if (accountList) {
		accountList = accountList.map(function (name) {
			var opts = Storage.getItem('account.' + name);
			var self = new Account(opts);
			accounts[self.id] = self;
			return self;
		});

		var name = Storage.getItem('currentAccount');

		var accountByName = {};
		accountList.forEach(function (account) {
			accountByName[account.alias] = account;
		});
		currentAccount = accountByName[name];
	}

	else {
		accountList = [];
		$translate('account.initialname')
		.then(function (res) {
			Wallet.createEmptyAccount(res);
		});
	}

	Wallet.accountList = accountList;

	//------------------------------------------------------------------------------------------------------------------

	$rootScope.$on('newTransaction', function(event, args) {

		function getAccountAsset(account, asset_code, asset_issuer) {
			var entry = account.balances.filter(function (entry) {
				if (entry.asset_code === asset_code) {
					return true;
				}
			});

			return entry.length ? entry[0] : null;
		}

		if (!(args.address in accounts)) {
			return;
		}

		var account = accounts[args.address];
		var fx = args.res;
		var asset;

		function plus(a, b) {
			return new Decimal(a).plus(new Decimal(b)).toFixed(7);
		}

		function minus(a, b) {
			return new Decimal(a).minus(new Decimal(b)).toFixed(7);
		}

		if (fx.type === 'account_credited') {
			asset = getAccountAsset(account, fx.asset_code, fx.asset_issuer);
			asset.balance = plus(asset.balance, fx.amount);
		}

		else if (fx.type === 'account_debited') {
			asset = getAccountAsset(account, fx.asset_code, fx.asset_issuer);
			if (asset) {			//	if issuing asset, we don't track balances
				asset.balance = minus(asset.balance, fx.amount);
			}
		}

		else if (fx.type === 'trade') {
			asset = getAccountAsset(account, fx.sold_asset_code, fx.sold_asset_issuer);
			asset.balance = minus(asset.balance, fx.sold_amount);

			asset = getAccountAsset(account, fx.bought_asset_code, fx.bought_asset_issuer);
			asset.balance = plus(asset.balance, fx.bought_amount);
		}
	});

	return Wallet;
});