# Cashu Card POS (slice 0.3): the journal's directory, excluded from backup, and the few file operations the store needs.
Pod::Spec.new do |s|
  s.name         = 'CCPOSStore'
  s.version      = '0.0.0'
  s.summary      = 'Cashu Card POS: the journal directory, excluded from backup.'
  s.license      = 'MIT'
  s.author       = 'Cashu Card'
  s.homepage     = 'https://github.com/cashucard/cashu-card-pos'
  s.platforms    = { :ios => '15.1' }
  s.source       = { :path => '.' }
  s.source_files = 'ios/*.{h,m}'
  s.frameworks = 'UIKit', 'UniformTypeIdentifiers', 'AVFoundation'
  s.dependency 'OpenSSL-Universal'
  s.dependency 'React-Core'
end
