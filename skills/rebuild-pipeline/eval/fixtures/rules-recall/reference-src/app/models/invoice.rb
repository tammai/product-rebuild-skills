class Invoice < ApplicationRecord
  STATUSES = %w[draft issued partially_paid paid overdue void].freeze

  belongs_to :customer
  has_many :line_items, dependent: :destroy
  has_many :payments

  enum status: STATUSES.index_with(&:itself)

  validates :currency, presence: true

  def subtotal
    line_items.sum(:amount)
  end

  def outstanding
    total - payments.succeeded.sum(:amount)
  end

  def recalculate_totals!
    rate = BillingConfig.tax_rate_for(customer.region)
    self.tax_amount = (subtotal * rate).round(2, half: :even)
    self.total = subtotal + tax_amount
    save!
  end

  def days_overdue(today = Date.current)
    return 0 if due_date.nil? || today <= due_date

    (today - due_date).to_i
  end
end
