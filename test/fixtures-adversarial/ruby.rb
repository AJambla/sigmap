# Adversarial: nested defaults, keyword args, block params.
def nested_default(a = g(1, 2), b: h(3))
  a
end

def keyword_args(a:, b: 2)
  a + b
end

def string_delims(sep = ")")
  sep
end
