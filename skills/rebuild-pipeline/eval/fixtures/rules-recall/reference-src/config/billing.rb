module BillingConfig
  TAX_RATES = {
    "EU" => BigDecimal("0.20"),
    "UK" => BigDecimal("0.20"),
    "SG" => BigDecimal("0.09")
  }.freeze

  LATE_FEE_RATE = BigDecimal("0.015")
  LATE_FEE_PERIOD_DAYS = 30
  LATE_FEE_CAP = BigDecimal("25.00")

  PAYMENT_MAX_ATTEMPTS = 3
  PAYMENT_RETRY_BASE_MINUTES = 5

  def self.tax_rate_for(region)
    TAX_RATES.fetch(region, BigDecimal("0"))
  end
end
